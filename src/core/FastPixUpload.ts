import RNBlobUtil from 'react-native-blob-util';
import { TypedEventEmitter } from '../utils/EventEmitter';
import { NetworkMonitor } from './NetworkMonitor';
import { UploadEngine } from './UploadEngine';
import { validateAndNormalizeOptions, resolveEndpoint } from '../utils/validation';
import { chunkIndexForOffset } from './ChunkEngine';
import type {
  FastPixUploadOptions,
  UploadState,
  UploadEventName,
  UploadEventCallback,
  UploadProgressSnapshot,
} from '../types';

import { SDK_CONFIG } from '../utils/config';
import { info, log, warn } from '../utils/logger';

const VALID_TRANSITIONS: Readonly<Record<UploadState, readonly UploadState[]>> = {
  IDLE:      ['STARTED'],
  STARTED:   ['UPLOADING', 'FAILED', 'IDLE'],
  UPLOADING: ['PAUSED', 'FAILED', 'COMPLETED', 'IDLE'],
  PAUSED:    ['RESUMED', 'IDLE'],
  RESUMED:   ['UPLOADING', 'FAILED', 'IDLE'],
  FAILED:    ['IDLE'],
  COMPLETED: ['IDLE'],
};

export class FastPixUpload {
  private _state: UploadState = 'IDLE';

  private readonly _opts: Required<FastPixUploadOptions>;
  private readonly _emitter = new TypedEventEmitter();
  private readonly _networkMonitor = new NetworkMonitor();
  private _engine: UploadEngine | null = null;

  private _resolvedFileUri = '';
  private _resolvedEndpoint = '';
  private _fileSizeBytes = 0;
  private _uploadedOffset = 0;
  private _pausedByUser = false;

  private _liveBytesUploaded = 0;
  private _livePercentage = 0;

  private readonly _stateHistory: Array<{ from: UploadState; to: UploadState; at: number }> = [];

  constructor(opts: FastPixUploadOptions) {
    this._opts = validateAndNormalizeOptions(opts);
    SDK_CONFIG.enableLogs = !!this._opts.enableLogs;
    log('[FastPix:FastPixUpload] Constructor initialized', {
      timestamp: new Date().toISOString(),
      chunkSize: this._opts.chunkSize,
      maxRetries: this._opts.maxRetries,
      retryDelay: this._opts.retryDelay,
      autoHandleNetworkEvents: this._opts.autoHandleNetworkEvents,
      fileUri: this._maskPath(this._opts.fileUri),
      endpoint: this._maskUrl(typeof this._opts.endpoint === 'string' ? this._opts.endpoint : 'factory-function'),
    });
  }

  private _maskUrl(url: string): string {
    if (!url || url === 'factory-function') return url;
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}/.../[masked]`;
    } catch {
      return '[invalid-url]';
    }
  }

  private _maskPath(path: string): string {
    if (!path) return path;
    const parts = path.split('/');
    return `.../${parts[parts.length - 1]}`;
  }

  on<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): () => void {
    return this._emitter.on(event, callback);
  }

  off<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): void {
    this._emitter.off(event, callback);
  }

  async start(): Promise<void> {
    if (this._state !== 'IDLE') {
      warn(`[FastPix] start() ignored — current state is "${this._state}".`);
      return;
    }
    log('[FastPix:FastPixUpload] start() called', { timestamp: new Date().toISOString(), currentState: this._state });
    this._transitionTo('STARTED');
    try {
      await this._beginUpload();
    } catch (err) {
      this._handleFatalError(err);
    }
  }

  pause(): void {
    if (this._state !== 'UPLOADING') {
      warn(`[FastPix] pause() ignored — current state is "${this._state}".`);
      return;
    }
    log('[FastPix:FastPixUpload] pause() called by user', {
      timestamp: new Date().toISOString(),
      uploadedOffset: this._uploadedOffset,
      totalBytes: this._fileSizeBytes,
    });
    this._pausedByUser = true;
    this._engine?.abort();
    this._transitionTo('PAUSED');
    this._emitter.emit('pause', { reason: 'user' });
  }

  async resume(): Promise<void> {
    if (this._state !== 'PAUSED') {
      warn(`[FastPix] resume() ignored — current state is "${this._state}".`);
      return;
    }
    log('[FastPix:FastPixUpload] resume() called', {
      timestamp: new Date().toISOString(),
      resumeFromOffset: this._uploadedOffset,
    });
    this._pausedByUser = false;
    try {
      await this._syncResumeOffset();
      this._transitionTo('RESUMED');
      this._emitter.emit('resume', { fromOffset: this._uploadedOffset });
      await this._continueUpload();
    } catch (err) {
      this._handleFatalError(err);
    }
  }

  abort(): void {
    if (this._state === 'IDLE') return;
    log('[FastPix:FastPixUpload] abort() called', {
      timestamp: new Date().toISOString(),
      currentState: this._state,
      uploadedOffset: this._uploadedOffset,
    });
    this._engine?.abort();
    this._networkMonitor.stop();
    this._emitter.emit('abort', undefined);
    this._transitionTo('IDLE');
    this._emitter.removeAllListeners();
    this._uploadedOffset = 0;
    this._fileSizeBytes = 0;
    this._resolvedEndpoint = '';
    this._resolvedFileUri = '';
    this._pausedByUser = false;
  }

  get state(): UploadState { return this._state; }

  get progress(): UploadProgressSnapshot {
    const bytesUploaded =
      this._state === 'UPLOADING' || this._state === 'RESUMED'
        ? this._liveBytesUploaded
        : this._uploadedOffset;

    const percentage =
      this._state === 'UPLOADING' || this._state === 'RESUMED'
        ? this._livePercentage
        : this._fileSizeBytes > 0
          ? Math.floor((this._uploadedOffset / this._fileSizeBytes) * 100)
          : 0;

    return {
      state: this._state,
      bytesUploaded,
      bytesTotal: this._fileSizeBytes,
      percentage,
      currentChunkIndex: chunkIndexForOffset(bytesUploaded, this._opts.chunkSize),
    };
  }

  get stateHistory(): ReadonlyArray<{ from: UploadState; to: UploadState; at: number }> {
    return this._stateHistory;
  }

  private async _beginUpload(): Promise<void> {
    this._resolvedEndpoint = await resolveEndpoint(this._opts.endpoint);
    this._resolvedFileUri = decodeURIComponent(this._opts.fileUri.replace(/^file:\/\//, ''));

    const stat = await RNBlobUtil.fs.stat(this._resolvedFileUri);
    this._fileSizeBytes = parseInt(String(stat.size), 10);

    if (!Number.isFinite(this._fileSizeBytes) || this._fileSizeBytes <= 0) {
      throw new Error(`[FastPix] File is empty or could not be read: ${this._opts.fileUri}`);
    }

    if (this._opts.maxFileSize > 0 && this._fileSizeBytes > this._opts.maxFileSize) {
      const fileMB = (this._fileSizeBytes / (1024 * 1024)).toFixed(2);
      const limitMB = (this._opts.maxFileSize / (1024 * 1024)).toFixed(2);
      throw new Error(`[FastPix] File size ${fileMB} MB exceeds the maximum allowed size of ${limitMB} MB.`);
    }

    if (this._opts.autoHandleNetworkEvents) {
      log('[FastPix:FastPixUpload] Setting up network handling', { timestamp: new Date().toISOString() });
      this._setupNetworkHandling();
    }

    this._emitter.emit('started', { fileSize: this._fileSizeBytes, endpoint: this._resolvedEndpoint });
    this._transitionTo('UPLOADING');
    await this._runEngine(0);
  }

  private async _continueUpload(): Promise<void> {
    this._transitionTo('UPLOADING');
      log('[FastPix:FastPixUpload] Resuming from byte offset', {
        offset: this._uploadedOffset,
      });
    await this._runEngine(this._uploadedOffset);
  }

  private async _runEngine(startOffset: number): Promise<void> {
    log('[FastPix:FastPixUpload] _runEngine() initialized', {
      timestamp: new Date().toISOString(),
      startOffset,
      fileSize: this._fileSizeBytes,
      chunkSize: this._opts.chunkSize,
    });

    const engineStartTime = Date.now();
    this._engine = new UploadEngine({
      endpoint: this._resolvedEndpoint,
      fileUri: this._resolvedFileUri,
      fileSizeBytes: this._fileSizeBytes,
      chunkSizeKB: this._opts.chunkSize,
      maxRetries: this._opts.maxRetries,
      retryDelay: this._opts.retryDelay,

      onChunkAttempt: (chunkIndex, attemptNumber, totalChunkNumbers) => {
        log('[FastPix:FastPixUpload] Chunk attempt', { chunkIndex, attemptNumber, totalChunkNumbers });
        this._emitter.emit('chunkAttempt', { chunkIndex, attemptNumber, totalChunkNumbers });
      },

      onChunkAttemptFailure: (chunkIndex, attemptNumber, error) => {
        log('[FastPix:FastPixUpload] Chunk attempt failure', { chunkIndex, attemptNumber, error: error.message });
        this._emitter.emit('chunkAttemptFailure', { chunkIndex, attemptNumber, error });
      },

      onChunkSuccess: (chunkIndex, newOffset) => {
        this._uploadedOffset = newOffset;
        this._liveBytesUploaded = newOffset;
        this._livePercentage = Math.floor((newOffset / this._fileSizeBytes) * 100);
        const progressPercent = Math.round((newOffset / this._fileSizeBytes) * 100);
        log('[FastPix:FastPixUpload] Chunk success', { chunkIndex, newOffset, totalBytes: this._fileSizeBytes, progressPercent });
        this._emitter.emit('chunkSuccess', { chunkIndex, offset: newOffset });
      },

      onProgress: (sentBytes, chunkStart, _chunkEnd, fileSizeBytes) => {
        const bytesUploaded = Math.min(chunkStart + sentBytes, fileSizeBytes);
        const percentage = Math.floor((bytesUploaded / fileSizeBytes) * 100);

        this._liveBytesUploaded = bytesUploaded;
        this._livePercentage = percentage;

        this._emitter.emit('progress', {
          bytesUploaded,
          bytesTotal: fileSizeBytes,
          percentage,
        });
      },
    });

    this._engine.setStartOffset(startOffset);

    const result = await this._engine.run();
    const engineDuration = Date.now() - engineStartTime;

    if (result.success) {
      log('[FastPix:FastPixUpload] Upload completed successfully', {
        duration: `${engineDuration}ms`,
        totalBytes: this._fileSizeBytes,
        timestamp: new Date().toISOString(),
      });
      this._transitionTo('COMPLETED');
      this._emitter.emit('success', undefined);
      this._networkMonitor.stop();
      return;
    }

    const message = result.error?.message ?? 'Unknown upload error.';
    const isIntentionalAbort = message.includes('aborted') && this._state === 'PAUSED';

    if (isIntentionalAbort) {
      log('[FastPix:FastPixUpload] Upload paused intentionally', { duration: `${engineDuration}ms`, uploadedOffset: this._uploadedOffset });
      return;
    }

    log('[FastPix:FastPixUpload] Upload failed', { duration: `${engineDuration}ms`, error: message, uploadedOffset: this._uploadedOffset });
    this._transitionTo('FAILED');
    this._emitter.emit('error', { message, retriable: false, code: 'UPLOAD_FAILED' });
  }

  private _setupNetworkHandling(): void {
    log('[FastPix:FastPixUpload] Network monitoring started', { timestamp: new Date().toISOString() });
    this._networkMonitor.start();

    this._networkMonitor.onChange((status) => {
      log('[FastPix:FastPixUpload] Network status changed', {
        timestamp: new Date().toISOString(),
        newStatus: status,
        currentState: this._state,
        pausedByUser: this._pausedByUser,
      });

      if (status === 'offline') {
        this._emitter.emit('offline', undefined);
        if (this._state === 'UPLOADING') {
          this._engine?.abort();
          this._transitionTo('PAUSED');
          this._emitter.emit('pause', { reason: 'network' });
        }
      } else if (status === 'online') {
        this._emitter.emit('online', undefined);
        if (this._state === 'PAUSED' && !this._pausedByUser) {
          this.resume().catch((err: unknown) => this._handleFatalError(err));
        }
      }
    });
  }

  private async _syncResumeOffset(): Promise<void> {
    if (!this._resolvedEndpoint || this._fileSizeBytes <= 0) return;

    try {
      const response = await fetch(this._resolvedEndpoint, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes */${this._fileSizeBytes}`,
          'Content-Length': '0',
        },
      });

      // 308 = resumable upload incomplete, server tells us uploaded range
      if (response.status === 308) {
        const rangeHeader =
          response.headers.get('range') ?? response.headers.get('Range');

        if (rangeHeader) {
          const match = /bytes=0-(\d+)/i.exec(rangeHeader);
          if (match?.[1]) {
            const serverOffset = parseInt(match[1], 10) + 1;

            if (Number.isFinite(serverOffset) && serverOffset >= 0) {
              if (serverOffset !== this._uploadedOffset) {
                info(
                  `[FastPix] Resume offset corrected: local=${this._uploadedOffset} → server=${serverOffset}`,
                );
                this._uploadedOffset = serverOffset;
              }
            }
          }
        }

        return;
      }

      // Upload already complete
      if (response.status >= 200 && response.status < 300) {
        this._uploadedOffset = this._fileSizeBytes;
        this._transitionTo('COMPLETED');
        this._emitter.emit('success', undefined);
        this._networkMonitor.stop();
        return;
      }

      warn(
        `[FastPix] Resume probe returned unexpected status ${response.status}. Continuing from local offset ${this._uploadedOffset}.`,
      );
    } catch (err) {
      warn(
        '[FastPix] Could not verify resume offset. Continuing from local offset.',
        err,
      );
    }
  }

  private _transitionTo(next: UploadState): void {
    const allowed = VALID_TRANSITIONS[this._state];

    if (!allowed.includes(next)) {
      const msg = `[FastPix] Invalid state transition: ${this._state} → ${next}. Allowed: ${allowed.join(', ') || 'none'}.`;
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        throw new Error(msg);
      } else {
        warn(msg);
        return;
      }
    }

    const entry = { from: this._state, to: next, at: Date.now() };
    this._stateHistory.push(entry);
    if (this._stateHistory.length > 50) this._stateHistory.shift();

    const prev = this._state;
    this._state = next;
    this._emitter.emit('stateChange', { from: prev, to: next });
  }

  private _handleFatalError(err: unknown): void {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
    const canFail = VALID_TRANSITIONS[this._state]?.includes('FAILED') ?? false;
    if (canFail) this._transitionTo('FAILED');
    this._emitter.emit('error', { message, retriable: false, code: 'UNEXPECTED_ERROR' });
  }
}