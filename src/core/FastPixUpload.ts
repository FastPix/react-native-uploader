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

// ─── FSM transition table ─────────────────────────────────────────────────────

/**
 * Exhaustive map of every valid (fromState → toState) transition.
 * _transitionTo() enforces this — any unlisted transition throws in
 * development and is silently rejected in production.
 */
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
  /** Resolved upload endpoint URL. */
  private _resolvedEndpoint = '';
  /** Total file size in bytes, populated at start(). */
  private _fileSizeBytes = 0;
  /** Byte offset of the last server-acknowledged chunk boundary. */
  private _uploadedOffset = 0;
  /** True when pause() was called by the user (vs auto-paused by network). */
  private _pausedByUser = false;
  /**
   * Phase 3: state transition history for debugging.
   * Capped at 50 entries to avoid unbounded growth.
   */
  private readonly _stateHistory: Array<{ from: UploadState; to: UploadState; at: number }> = [];
  
  /** Timestamp tracking for state transition duration calculations */
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
  
  /** Helper to mask sensitive URLs */
  private _maskUrl(url: string): string {
    if (!url || url === 'factory-function') return url;
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}/.../[masked]`;
    } catch {
      return '[invalid-url]';
    }
  }
  
  /** Helper to mask file paths */
  private _maskPath(path: string): string {
    if (!path) return path;
    const parts = path.split('/');
    return `.../${parts[parts.length - 1]}`;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to an upload lifecycle event.
   * @returns A cleanup function — call it to unsubscribe (useful in useEffect).
   */
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

  /**
   * Initiate the upload.
   * Only valid when state is IDLE. Calling in any other state emits a
   * warning and is a no-op.
   */
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

  /**
   * Pause the active upload.
   * Only valid when state is UPLOADING. The in-flight chunk's HTTP request
   * is cancelled immediately; the last fully acknowledged offset is
   * preserved so resume() can continue from exactly that point.
   */
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

  /**
   * Resume a paused upload from the last acknowledged byte offset.
   * Only valid when state is PAUSED.
   *
   * Phase 4: Before resuming, we re-query the server for the current
   * acknowledged offset to guard against any mismatch between client-side
   * bookkeeping and the actual server state.
   */
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
      // Phase 4: validate and sync offset with server before continuing.
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

  /**
   * Permanently cancel the upload and release all resources.
   * The instance transitions back to IDLE and can be start()ed again.
   * All event listeners are removed.
   */
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
    this._pausedByUser = false;
    this._transitionTo('IDLE');
  }

  /** Current FSM state. */
  get state(): UploadState {
    return this._state;
  }

  /** Point-in-time progress snapshot. */
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

  /**
   * Phase 3: Read-only copy of the FSM transition history.
   * Useful for debugging and integration tests.
   */
  get stateHistory(): ReadonlyArray<{ from: UploadState; to: UploadState; at: number }> {
    return this._stateHistory;
  }

  // ─── Private orchestration ───────────────────────────────────────────────────

  private async _beginUpload(): Promise<void> {
    const beginStartTime = Date.now();
    console.log('[FastPix:FastPixUpload] _beginUpload() starting', {
      timestamp: new Date().toISOString(),
    });

    // 1. Resolve the endpoint URL (handles string and async factory).
    const endpointResolveStart = Date.now();
    this._resolvedEndpoint = await resolveEndpoint(this._opts.endpoint);
    const endpointResolveDuration = Date.now() - endpointResolveStart;
    console.log('[FastPix:FastPixUpload] Endpoint resolved', {
      duration: `${endpointResolveDuration}ms`,
      endpoint: this._maskUrl(this._resolvedEndpoint),
    });

    // 2. Stat the file to get its exact byte size.
    //    react-native-blob-util returns stat.size as a string on both platforms.
    const statStartTime = Date.now();
    const stat = await RNBlobUtil.fs.stat(this._opts.fileUri);
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

    // 3. Wire up network-aware auto-pause/resume (Phase 4).
    if (this._opts.autoHandleNetworkEvents) {
      console.log('[FastPix:FastPixUpload] Setting up network handling', {
        timestamp: new Date().toISOString(),
      });
      this._setupNetworkHandling();
    }

    // 4. Emit started, transition to UPLOADING, run from chunk 0.
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
      fileUri: this._opts.fileUri,
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
      // Engine was stopped by pause() — not an error, do not transition.
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

  // ─── Phase 4: Network resilience ─────────────────────────────────────────────

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
          // Auto-pause. _pausedByUser stays false so that when
          // the connection returns we auto-resume.
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
          // Auto-resume. Run the full resume() flow (including offset sync).
          this.resume().catch((err: unknown) => this._handleFatalError(err));
        }
      }
    });
  }

  /**
   * Phase 4: Offset validation before resume.
   *
   * Sends a zero-byte PUT with `Content-Range: bytes *‌/<fileSize>` to ask
   * the server for the byte range it has already received. The server
   * responds with 308 Resume Incomplete and a `Range` header indicating the
   * last acknowledged offset.
   *
   * If the server offset differs from our local _uploadedOffset we trust
   * the server and update our local state. This prevents duplicate chunk
   * uploads after a hard crash or network drop mid-chunk.
   *
   * If the query fails (network still down, server error) we log a warning
   * and proceed with the locally stored offset — the chunk-level retry
   * logic in UploadEngine will handle any resulting server-side duplicate.
   */
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
          // Expect 308 Resume Incomplete; 200/201 means the upload is already
          // complete (shouldn't happen in PAUSED state but handle it cleanly).
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
        // The Range header format is "bytes=0-<lastByte>" (0-based, inclusive).
        const rangeHeader: string | undefined =
          response.headers?.['range'] as string | undefined;

        if (rangeHeader) {
          const match = /bytes=0-(\d+)/.exec(rangeHeader);
          if (match?.[1]) {
            const serverOffset = parseInt(match[1], 10) + 1; // convert to exclusive end
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

  // ─── Phase 3: FSM helpers ─────────────────────────────────────────────────────

  /**
   * Perform a guarded state transition.
   *
   * Enforces the VALID_TRANSITIONS table. Invalid transitions:
   *   - Throw in __DEV__ builds so developers catch FSM bugs immediately.
   *   - Are silently ignored in production to avoid crashing the user's app.
   */
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

    // Record the transition (Phase 3 state history).
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

    // Phase 3: emit stateChange for every valid transition.
    this._emitter.emit('stateChange', { from: prev, to: next });
  }

  private _handleFatalError(err: unknown): void {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred.';
    // Guard: only transition to FAILED if it's a valid move from current state.
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
