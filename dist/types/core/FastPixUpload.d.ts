import type { FastPixUploadOptions, UploadState, UploadEventName, UploadEventCallback, UploadProgressSnapshot } from '../types';
export declare class FastPixUpload {
    private _state;
    private readonly _opts;
    private readonly _emitter;
    private readonly _networkMonitor;
    private _engine;
    private _resolvedFileUri;
    private _resolvedEndpoint;
    private _fileSizeBytes;
    private _uploadedOffset;
    private _pausedByUser;
    private _liveBytesUploaded;
    private _livePercentage;
    private readonly _stateHistory;
    constructor(opts: FastPixUploadOptions);
    private _maskUrl;
    private _maskPath;
    on<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): () => void;
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