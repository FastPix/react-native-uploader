import type { FastPixUploadOptions, UploadState, UploadEventName, UploadEventCallback, UploadProgressSnapshot } from '../types';
export declare class FastPixUpload {
    private _state;
    private readonly _opts;
    private readonly _emitter;
    private readonly _networkMonitor;
    private _engine;
    /** Resolved upload endpoint URL. */
    private _resolvedEndpoint;
    /** Total file size in bytes, populated at start(). */
    private _fileSizeBytes;
    /** Byte offset of the last server-acknowledged chunk boundary. */
    private _uploadedOffset;
    /** True when pause() was called by the user (vs auto-paused by network). */
    private _pausedByUser;
    /**
     * Phase 3: state transition history for debugging.
     * Capped at 50 entries to avoid unbounded growth.
     */
    private readonly _stateHistory;
    constructor(opts: FastPixUploadOptions);
    /**
     * Subscribe to an upload lifecycle event.
     * @returns A cleanup function — call it to unsubscribe (useful in useEffect).
     */
    on<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): () => void;
    /** Remove a previously registered event listener. */
    off<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): void;
    /**
     * Initiate the upload.
     * Only valid when state is IDLE. Calling in any other state emits a
     * warning and is a no-op.
     */
    start(): Promise<void>;
    /**
     * Pause the active upload.
     * Only valid when state is UPLOADING. The in-flight chunk's HTTP request
     * is cancelled immediately; the last fully acknowledged offset is
     * preserved so resume() can continue from exactly that point.
     */
    pause(): void;
    /**
     * Resume a paused upload from the last acknowledged byte offset.
     * Only valid when state is PAUSED.
     *
     * Phase 4: Before resuming, we re-query the server for the current
     * acknowledged offset to guard against any mismatch between client-side
     * bookkeeping and the actual server state.
     */
    resume(): Promise<void>;
    /**
     * Permanently cancel the upload and release all resources.
     * The instance transitions back to IDLE and can be start()ed again.
     * All event listeners are removed.
     */
    abort(): void;
    /** Current FSM state. */
    get state(): UploadState;
    /** Point-in-time progress snapshot. */
    get progress(): UploadProgressSnapshot;
    /**
     * Phase 3: Read-only copy of the FSM transition history.
     * Useful for debugging and integration tests.
     */
    get stateHistory(): ReadonlyArray<{
        from: UploadState;
        to: UploadState;
        at: number;
    }>;
    private _beginUpload;
    private _continueUpload;
    private _runEngine;
    private _setupNetworkHandling;
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
    private _syncResumeOffset;
    /**
     * Perform a guarded state transition.
     *
     * Enforces the VALID_TRANSITIONS table. Invalid transitions:
     *   - Throw in __DEV__ builds so developers catch FSM bugs immediately.
     *   - Are silently ignored in production to avoid crashing the user's app.
     */
    private _transitionTo;
    private _handleFatalError;
}
//# sourceMappingURL=FastPixUpload.d.ts.map