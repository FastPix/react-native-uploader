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
    /**
     * Fired continuously as bytes move through the native layer.
     * Mirrors the web SDK's `xhr.upload.onprogress` — called on every native
     * progress tick, not just once per completed chunk.
     */
    onProgress: (bytesUploaded: number, bytesTotal: number) => void;
}
export interface EngineResult {
    success: boolean;
    error?: Error;
}
export declare class UploadEngine {
    private readonly _opts;
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
    /**
     * Resets the stall watchdog.
     *
     * Previously this was called once before `RNBlobUtil.fetch` and cleared
     * after it resolved — so for a 500 MB chunk taking 65 s, the 30 s timer
     * fired and called `abort()` even though bytes were actively moving through
     * the native layer.  The fix: call this on every native progress tick so
     * the timer only fires when bytes genuinely stop moving.
     */
    private _resetStallWatchdog;
    private _uploadChunk;
}
//# sourceMappingURL=UploadEngine.d.ts.map