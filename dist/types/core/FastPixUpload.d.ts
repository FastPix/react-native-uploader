import type { FastPixUploadOptions, UploadState, UploadEventName, UploadEventCallback, UploadProgressSnapshot } from '../types';
export declare class FastPixUpload {
    private _state;
    private readonly _opts;
    private readonly _emitter;
    private readonly _networkMonitor;
    private _engine;
    /** fileUri with file:// scheme stripped — the form RNBlobUtil expects. */
    private _resolvedFileUri;
    /** Resolved upload endpoint URL. */
    private _resolvedEndpoint;
    /** Total file size in bytes, populated at start(). */
    private _fileSizeBytes;
    /** Byte offset of the last server-acknowledged chunk boundary. */
    private _uploadedOffset;
    /** True when pause() was called by the user (vs auto-paused by network). */
    private _pausedByUser;
    private readonly _stateHistory;
    private _stateChangeTime;
    constructor(opts: FastPixUploadOptions);
    private _maskUrl;
    private _maskPath;
    on<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): () => void;
    /** Remove a previously registered event listener. */
    off<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): void;
    start(): Promise<void>;
    pause(): void;
    resume(): Promise<void>;
    abort(): void;
    get state(): UploadState;
    get progress(): UploadProgressSnapshot;
    get stateHistory(): ReadonlyArray<{
        from: UploadState;
        to: UploadState;
        at: number;
    }>;
    private _beginUpload;
    private _continueUpload;
    private _runEngine;
    private _setupNetworkHandling;
    private _syncResumeOffset;
    private _transitionTo;
    private _handleFatalError;
}
//# sourceMappingURL=FastPixUpload.d.ts.map