export interface UploadEngineOptions {
    endpoint: string;
    fileUri: string;
    fileSizeBytes: number;
    chunkSizeKB: number;
    maxRetries: number;
    retryDelay: number;
    /** Fired at the start of every chunk attempt (including retries). */
    onChunkAttempt: (chunkIndex: number, attemptNumber: number, totalChunkNumbers: number) => void;
    /** Fired when a chunk attempt fails but will be retried. */
    onChunkAttemptFailure: (chunkIndex: number, attemptNumber: number, error: Error) => void;
    /** Fired after a chunk is fully acknowledged by the server. */
    onChunkSuccess: (chunkIndex: number, newOffset: number) => void;
    /** Fired after each successful chunk with cumulative byte counts. */
    onProgress: (bytesUploaded: number, bytesTotal: number) => void;
}
export interface EngineResult {
    success: boolean;
    error?: Error;
}
export declare class UploadEngine {
    private readonly _opts;
    private _cancelSource;
    private _abortController;
    private _startChunkIndex;
    /** 30s stall watchdog — cancels a chunk if no upload progress is reported. */
    private _stallTimer;
    private readonly STALL_TIMEOUT_MS;
    constructor(opts: UploadEngineOptions);
    setStartChunkIndex(index: number): void;
    abort(): void;
    run(): Promise<EngineResult>;
    private _clearStallWatchdog;
    private _resetStallWatchdog;
    private _uploadChunk;
    private _readChunkAsBase64;
}
//# sourceMappingURL=UploadEngine.d.ts.map