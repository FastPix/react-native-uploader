export interface UploadEngineOptions {
    endpoint: string;
    fileUri: string;
    fileSizeBytes: number;
    chunkSizeKB: number;
    maxRetries: number;
    retryDelay: number;
    onChunkAttempt: (chunkIndex: number, attemptNumber: number, totalChunkNumbers: number) => void;
    onChunkAttemptFailure: (chunkIndex: number, attemptNumber: number, error: Error) => void;
    onChunkSuccess: (chunkIndex: number, newOffset: number) => void;
    onProgress: (sentBytes: number, chunkStart: number, chunkEnd: number, fileSizeBytes: number, chunkIndex: number, totalChunks: number) => void;
}
export interface EngineResult {
    success: boolean;
    error?: Error;
}
export declare class UploadEngine {
    private readonly _opts;
    private _abortController;
    private _startOffset;
    private _activeRequest;
    private _syntheticTicker;
    private _lastThroughputBytesPerMs;
    private _lastEmittedChunkBytes;
    constructor(opts: UploadEngineOptions);
    setStartOffset(offset: number): void;
    abort(): void;
    run(): Promise<EngineResult>;
    private _uploadChunkWithRetry;
    private _handleChunkUploadError;
    private _abortedResult;
    private _isAbortError;
    private _cleanupStaleTempFiles;
    private _checkDiskSpace;
    private _clearSyntheticTicker;
    private _startSyntheticTicker;
    private _uploadChunk;
}
//# sourceMappingURL=UploadEngine.d.ts.map