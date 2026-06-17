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

const VALID_TRANSITIONS: Readonly<Record<UploadState, readonly UploadState[]>> = {
  IDLE:      ['STARTED'],
  STARTED:   ['UPLOADING', 'FAILED', 'IDLE'],
  UPLOADING: ['PAUSED', 'FAILED', 'COMPLETED', 'IDLE'],
  PAUSED:    ['RESUMED', 'IDLE'],
  RESUMED:   ['UPLOADING', 'FAILED', 'IDLE'],
  FAILED:    ['IDLE'],
  COMPLETED: ['IDLE'],
};

// ─── FastPixUpload ────────────────────────────────────────────────────────────

export class FastPixUpload {
  private _state: UploadState = 'IDLE';

  // Internal components
  private readonly _opts: Required<FastPixUploadOptions>;
  private readonly _emitter = new TypedEventEmitter();
  private readonly _networkMonitor = new NetworkMonitor();
  private _engine: UploadEngine | null = null;

  // Upload bookkeeping
  /** fileUri with file:// scheme stripped — the form RNBlobUtil expects. */
  private _resolvedFileUri = '';
  /** Resolved upload endpoint URL. */
  private _resolvedEndpoint = '';
  /** Total file size in bytes, populated at start(). */
  private _fileSizeBytes = 0;
  /** Byte offset of the last server-acknowledged chunk boundary. */
  private _uploadedOffset = 0;
  /** True when pause() was called by the user (vs auto-paused by network). */
  private _pausedByUser = false;

  private readonly _stateHistory: Array<{ from: UploadState; to: UploadState; at: number }> = [];
  
  private _stateChangeTime = 0;

  constructor(opts: FastPixUploadOptions) {
    this._opts = validateAndNormalizeOptions(opts);
    console.log('[FastPix:FastPixUpload] Constructor initialized', {
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

  // ─── Public API ─────────────────────────────────────────────────────────────

  on<K extends UploadEventName>(
    event: K,
    callback: UploadEventCallback<K>,
  ): () => void {
    return this._emitter.on(event, callback);
  }

  /** Remove a previously registered event listener. */
  off<K extends UploadEventName>(
    event: K,
    callback: UploadEventCallback<K>,
  ): void {
    this._emitter.off(event, callback);
  }

  async start(): Promise<void> {
    if (this._state !== 'IDLE') {
      console.warn(
        `[FastPix] start() ignored — current state is "${this._state}". ` +
          'Call abort() to reset before starting again.',
      );
      console.log('[FastPix:FastPixUpload] start() called in invalid state', {
        timestamp: new Date().toISOString(),
        currentState: this._state,
      });
      return;
    }

    console.log('[FastPix:FastPixUpload] start() called', {
      timestamp: new Date().toISOString(),
      currentState: this._state,
    });

    this._transitionTo('STARTED');

    try {
      await this._beginUpload();
    } catch (err) {
      this._handleFatalError(err);
    }
  }

  pause(): void {
    if (this._state !== 'UPLOADING') {
      console.warn(
        `[FastPix] pause() ignored — current state is "${this._state}".`,
      );
      console.log('[FastPix:FastPixUpload] pause() called in invalid state', {
        timestamp: new Date().toISOString(),
        currentState: this._state,
      });
      return;
    }

    console.log('[FastPix:FastPixUpload] pause() called by user', {
      timestamp: new Date().toISOString(),
      currentState: this._state,
      uploadedOffset: this._uploadedOffset,
      totalBytes: this._fileSizeBytes,
      progressPercent: Math.round((this._uploadedOffset / this._fileSizeBytes) * 100),
    });

    this._pausedByUser = true;
    this._engine?.abort();
    this._transitionTo('PAUSED');
    this._emitter.emit('pause', { reason: 'user' });
  }

  async resume(): Promise<void> {
    if (this._state !== 'PAUSED') {
      console.warn(
        `[FastPix] resume() ignored — current state is "${this._state}".`,
      );
      console.log('[FastPix:FastPixUpload] resume() called in invalid state', {
        timestamp: new Date().toISOString(),
        currentState: this._state,
      });
      return;
    }

    console.log('[FastPix:FastPixUpload] resume() called', {
      timestamp: new Date().toISOString(),
      currentState: this._state,
      resumeFromOffset: this._uploadedOffset,
      totalBytes: this._fileSizeBytes,
    });

    this._pausedByUser = false;

    try {
      const syncStartTime = Date.now();
      await this._syncResumeOffset();
      const syncDuration = Date.now() - syncStartTime;
      console.log('[FastPix:FastPixUpload] Sync complete', {
        duration: `${syncDuration}ms`,
        offsetAfterSync: this._uploadedOffset,
      });

      this._transitionTo('RESUMED');
      this._emitter.emit('resume', { fromOffset: this._uploadedOffset });
      await this._continueUpload();
    } catch (err) {
      this._handleFatalError(err);
    }
  }

  abort(): void {
    console.log('[FastPix:FastPixUpload] abort() called', {
      timestamp: new Date().toISOString(),
      currentState: this._state,
      uploadedOffset: this._uploadedOffset,
      totalBytes: this._fileSizeBytes,
    });

    this._engine?.abort();
    this._networkMonitor.stop();
    this._emitter.removeAllListeners();
    this._uploadedOffset = 0;
    this._fileSizeBytes = 0;
    this._resolvedEndpoint = '';
    this._resolvedFileUri = '';
    this._pausedByUser = false;
    this._transitionTo('IDLE');
  }

  get state(): UploadState {
    return this._state;
  }

  get progress(): UploadProgressSnapshot {
    return {
      state: this._state,
      bytesUploaded: this._uploadedOffset,
      bytesTotal: this._fileSizeBytes,
      percentage:
        this._fileSizeBytes > 0
          ? Math.round((this._uploadedOffset / this._fileSizeBytes) * 100)
          : 0,
      currentChunkIndex: chunkIndexForOffset(
        this._uploadedOffset,
        this._opts.chunkSize,
      ),
    };
  }


  get stateHistory(): ReadonlyArray<{ from: UploadState; to: UploadState; at: number }> {
    return this._stateHistory;
  }

  // ─── Private orchestration ───────────────────────────────────────────────────

  private async _beginUpload(): Promise<void> {
    const beginStartTime = Date.now();
    console.log('[FastPix:FastPixUpload] _beginUpload() starting', {
      timestamp: new Date().toISOString(),
    });

    const endpointResolveStart = Date.now();
    this._resolvedEndpoint = await resolveEndpoint(this._opts.endpoint);
    this._resolvedFileUri = this._opts.fileUri.replace(/^file:\/\//, '');

    const endpointResolveDuration = Date.now() - endpointResolveStart;
    console.log('[FastPix:FastPixUpload] Endpoint resolved', {
      duration: `${endpointResolveDuration}ms`,
      endpoint: this._maskUrl(this._resolvedEndpoint),
    });

    const statStartTime = Date.now();
    const stat = await RNBlobUtil.fs.stat(this._resolvedFileUri);
    this._fileSizeBytes = parseInt(String(stat.size), 10);
    const statDuration = Date.now() - statStartTime;
    console.log('[FastPix:FastPixUpload] File stat retrieved', {
      duration: `${statDuration}ms`,
      fileUri: this._maskPath(this._opts.fileUri),
      fileSizeBytes: this._fileSizeBytes,
      fileSizeMB: (this._fileSizeBytes / (1024 * 1024)).toFixed(2),
    });

    if (!Number.isFinite(this._fileSizeBytes) || this._fileSizeBytes <= 0) {
      throw new Error(
        `[FastPix] File is empty or could not be read: ${this._opts.fileUri}`,
      );
    }

    if (this._opts.autoHandleNetworkEvents) {
      console.log('[FastPix:FastPixUpload] Setting up network handling', {
        timestamp: new Date().toISOString(),
      });
      this._setupNetworkHandling();
    }

    const beginDuration = Date.now() - beginStartTime;
    console.log('[FastPix:FastPixUpload] Emitting started event', {
      duration: `${beginDuration}ms`,
      fileSize: this._fileSizeBytes,
    });

    this._emitter.emit('started', {
      fileSize: this._fileSizeBytes,
      endpoint: this._resolvedEndpoint,
    });
    this._transitionTo('UPLOADING');
    await this._runEngine(0);
  }

  private async _continueUpload(): Promise<void> {
    console.log('[FastPix:FastPixUpload] _continueUpload() starting', {
      timestamp: new Date().toISOString(),
      uploadedOffset: this._uploadedOffset,
      chunkSize: this._opts.chunkSize,
    });

    this._transitionTo('UPLOADING');
    const resumeChunkIndex = chunkIndexForOffset(
      this._uploadedOffset,
      this._opts.chunkSize,
    );
    console.log('[FastPix:FastPixUpload] Resuming from chunk', {
      chunkIndex: resumeChunkIndex,
      offset: this._uploadedOffset,
    });
    await this._runEngine(resumeChunkIndex);
  }

  private async _runEngine(startChunkIndex: number): Promise<void> {
    console.log('[FastPix:FastPixUpload] _runEngine() initialized', {
      timestamp: new Date().toISOString(),
      startChunkIndex,
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
        console.log('[FastPix:FastPixUpload] Chunk attempt', {
          chunkIndex,
          attemptNumber,
          totalChunkNumbers,
        });
        this._emitter.emit('chunkAttempt', { chunkIndex, attemptNumber, totalChunkNumbers });
      },

      onChunkAttemptFailure: (chunkIndex, attemptNumber, error) => {
        console.log('[FastPix:FastPixUpload] Chunk attempt failure', {
          chunkIndex,
          attemptNumber,
          error: error.message,
        });
        this._emitter.emit('chunkAttemptFailure', { chunkIndex, attemptNumber, error });
      },

      onChunkSuccess: (chunkIndex, newOffset) => {
        this._uploadedOffset = newOffset;
        const progressPercent = Math.round((newOffset / this._fileSizeBytes) * 100);
        console.log('[FastPix:FastPixUpload] Chunk success', {
          chunkIndex,
          newOffset,
          totalBytes: this._fileSizeBytes,
          progressPercent,
        });
        this._emitter.emit('chunkSuccess', { chunkIndex, offset: newOffset });
      },

      onProgress: (bytesUploaded, bytesTotal) => {
        this._emitter.emit('progress', {
          bytesUploaded,
          bytesTotal,
          percentage: Math.round((bytesUploaded / bytesTotal) * 100),
        });
      },
    });

    this._engine.setStartChunkIndex(startChunkIndex);

    const result = await this._engine.run();
    const engineDuration = Date.now() - engineStartTime;

    if (result.success) {
      console.log('[FastPix:FastPixUpload] Upload completed successfully', {
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
    const isIntentionalAbort =
      message.includes('aborted') && this._state === 'PAUSED';

    if (isIntentionalAbort) {
      console.log('[FastPix:FastPixUpload] Upload paused intentionally', {
        duration: `${engineDuration}ms`,
        uploadedOffset: this._uploadedOffset,
      });

      return;
    }

    console.log('[FastPix:FastPixUpload] Upload failed', {
      duration: `${engineDuration}ms`,
      error: message,
      uploadedOffset: this._uploadedOffset,
    });

    this._transitionTo('FAILED');
    this._emitter.emit('error', {
      message,
      retriable: false,
      code: 'UPLOAD_FAILED',
    });
  }

  private _setupNetworkHandling(): void {
    console.log('[FastPix:FastPixUpload] Network monitoring started', {
      timestamp: new Date().toISOString(),
    });
    this._networkMonitor.start();

    this._networkMonitor.onChange((status) => {
      console.log('[FastPix:FastPixUpload] Network status changed', {
        timestamp: new Date().toISOString(),
        newStatus: status,
        currentState: this._state,
        pausedByUser: this._pausedByUser,
      });

      if (status === 'offline') {
        this._emitter.emit('offline', undefined);

        if (this._state === 'UPLOADING') {
          console.log('[FastPix:FastPixUpload] Auto-pausing due to network offline', {
            timestamp: new Date().toISOString(),
            uploadedOffset: this._uploadedOffset,
          });
          this._engine?.abort();
          this._transitionTo('PAUSED');
          this._emitter.emit('pause', { reason: 'network' });
        }

      } else if (status === 'online') {
        this._emitter.emit('online', undefined);

        if (this._state === 'PAUSED' && !this._pausedByUser) {
          console.log('[FastPix:FastPixUpload] Auto-resuming due to network online', {
            timestamp: new Date().toISOString(),
            uploadedOffset: this._uploadedOffset,
          });
          this.resume().catch((err: unknown) => this._handleFatalError(err));
        }
      }
    });
  }

  private async _syncResumeOffset(): Promise<void> {
    if (!this._resolvedEndpoint) {
      // Upload hasn't started yet — nothing to sync.
      console.log('[FastPix:FastPixUpload] _syncResumeOffset() - no endpoint yet', {
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const syncStartTime = Date.now();
    console.log('[FastPix:FastPixUpload] _syncResumeOffset() starting', {
      timestamp: new Date().toISOString(),
      currentOffset: this._uploadedOffset,
      fileSize: this._fileSizeBytes,
      endpoint: this._maskUrl(this._resolvedEndpoint),
    });

    try {
      const axios = (await import('axios')).default;

      const response = await axios.put(
        this._resolvedEndpoint,
        undefined,
        {
          headers: {
            'Content-Range': `bytes */${this._fileSizeBytes}`,
            'Content-Length': '0',
          },
          validateStatus: (s) =>
            (s >= 200 && s < 300) || s === 308,
          timeout: 10_000,
        },
      );

      const syncDuration = Date.now() - syncStartTime;
      console.log('[FastPix:FastPixUpload] Sync response received', {
        duration: `${syncDuration}ms`,
        status: response.status,
        contentRange: response.headers?.['content-range'] as string | undefined,
      });

      if (response.status === 308) {
        const rangeHeader: string | undefined =
          response.headers?.['range'] as string | undefined;

        if (rangeHeader) {
          const match = /bytes=0-(\d+)/.exec(rangeHeader);
          if (match?.[1]) {
            const serverOffset = parseInt(match[1], 10) + 1; 
            if (serverOffset !== this._uploadedOffset) {
              console.info(
                `[FastPix] Resume offset corrected: ` +
                  `local=${this._uploadedOffset} → server=${serverOffset}`,
              );
              console.log('[FastPix:FastPixUpload] Offset mismatch detected and corrected', {
                localOffset: this._uploadedOffset,
                serverOffset,
                difference: serverOffset - this._uploadedOffset,
              });
              this._uploadedOffset = serverOffset;
            } else {
              console.log('[FastPix:FastPixUpload] Offset verified with server', {
                offset: this._uploadedOffset,
              });
            }
          }
        }
      } else if (response.status >= 200 && response.status < 300) {
        // Server already has the full file — mark as completed.
        console.log('[FastPix:FastPixUpload] Server confirms upload complete', {
          status: response.status,
        });
        this._uploadedOffset = this._fileSizeBytes;
        this._transitionTo('COMPLETED');
        this._emitter.emit('success', undefined);
        this._networkMonitor.stop();
      }
    } catch (err) {
      const syncDuration = Date.now() - syncStartTime;
      // Non-fatal — log and continue with locally stored offset.
      console.warn(
        '[FastPix] Could not verify resume offset with server. ' +
          'Continuing from local offset. Error:',
        err,
      );
      console.log('[FastPix:FastPixUpload] Sync offset failed (non-fatal)', {
        duration: `${syncDuration}ms`,
        error: err instanceof Error ? err.message : String(err),
        offset: this._uploadedOffset,
      });
    }
  }

  private _transitionTo(next: UploadState): void {
    const allowed = VALID_TRANSITIONS[this._state];

    if (!allowed.includes(next)) {
      const msg =
        `[FastPix] Invalid state transition: ${this._state} → ${next}. ` +
        `Allowed: ${allowed.join(', ') || 'none'}.`;

      console.log('[FastPix:FastPixUpload] Invalid state transition attempted', {
        timestamp: new Date().toISOString(),
        from: this._state,
        to: next,
        allowed,
      });

      // In RN, __DEV__ is a global boolean set by Metro.
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        throw new Error(msg);
      } else {
        console.warn(msg);
        return;
      }
    }

    const stateTransitionTime = Date.now();
    const timeSinceLastChange = this._stateChangeTime ? stateTransitionTime - this._stateChangeTime : 0;

    // Record the transition 
    const entry = { from: this._state, to: next, at: stateTransitionTime };
    this._stateHistory.push(entry);
    if (this._stateHistory.length > 50) {
      this._stateHistory.shift(); // keep the ring buffer bounded
    }

    const prev = this._state;
    this._state = next;
    this._stateChangeTime = stateTransitionTime;

    console.log('[FastPix:FastPixUpload] State transition', {
      timestamp: new Date().toISOString(),
      from: prev,
      to: next,
      timeSinceLast: timeSinceLastChange > 0 ? `${timeSinceLastChange}ms` : 'initial',
      uploadedOffset: this._uploadedOffset,
      totalBytes: this._fileSizeBytes,
    });

    // emit stateChange for every valid transition.
    this._emitter.emit('stateChange', { from: prev, to: next });
  }

  private _handleFatalError(err: unknown): void {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred.';
    const canFail = VALID_TRANSITIONS[this._state]?.includes('FAILED') ?? false;

    const stack = err instanceof Error ? err.stack : undefined;
    console.log('[FastPix:FastPixUpload] Fatal error occurred', {
      timestamp: new Date().toISOString(),
      currentState: this._state,
      error: message,
      canTransitionToFailed: canFail,
      uploadedOffset: this._uploadedOffset,
      totalBytes: this._fileSizeBytes,
      stack: stack ? stack.substring(0, 200) : undefined,
    });

    if (canFail) {
      this._transitionTo('FAILED');
    }
    this._emitter.emit('error', {
      message,
      retriable: false,
      code: 'UNEXPECTED_ERROR',
    });
  }
}
