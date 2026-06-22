/**
 * UploadEngine — native binary upload via RNBlobUtil.fetch
 *
 * Architecture mirrors the web SDK:
 *   1. RNBlobUtil.fs.slice(src, tempPath, start, end)  → temp file = file.slice()
 *   2. RNBlobUtil.fetch('PUT', url, headers, wrap(tempPath)) → native PUT = xhr.send(blob)
 *   3. Delete the temp file after the PUT resolves.
 *
 * JS heap impact = 0 bytes for the chunk body regardless of chunk size.
 */
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
    /**
     * Fired continuously as bytes move through the native layer.
     * sentBytes resets to 0 at the start of each new chunk.
     */
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
    /** Synthetic progress ticker for the chunk currently uploading. */
    private _syntheticTicker;
    /** Bytes-per-ms measured from the most recently completed chunk. */
    private _lastThroughputBytesPerMs;
    /**
     * Highest sentBytes value emitted (real or synthetic) for the CURRENT chunk.
     *
     * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
     * uploadProgress ticks fire with values that can temporarily decrease
     * (OS scheduler jitter, small corrections by the native layer). Without
     * this guard the progress bar would jump backwards.
     *
     * ── THE BUG IT WAS CAUSING ───────────────────────────────────────────────
     * Previously this field was an instance variable initialised once at
     * construction time and never reset between chunks. When chunk 1 started,
     * it still held chunk 0's final byte count (~524 MB for a 500 MB chunk).
     *
     * The synthetic ticker for chunk 1 estimates bytes from 0 and checks
     *   `if (estimated > this._lastEmittedChunkBytes)`
     * which is false (0 < 524 MB), so it emits nothing. Meanwhile
     * uploadProgress ticks for chunk 1 also start from small byte values
     * (< 524 MB) and are blocked by the same guard — so the progress bar
     * froze or oscillated between the chunk 0 ceiling and whatever tiny
     * native ticks slipped through.
     *
     * ── THE FIX ──────────────────────────────────────────────────────────────
     * Reset to 0 at the very start of _uploadChunk, before slice() and before
     * the ticker starts, so the guard starts fresh for every chunk.
     */
    private _lastEmittedChunkBytes;
    constructor(opts: UploadEngineOptions);
    setStartOffset(offset: number): void;
    abort(): void;
    run(): Promise<EngineResult>;
    private _cleanupStaleTempFiles;
    private _checkDiskSpace;
    private _clearSyntheticTicker;
    /**
     * Starts a 300ms interval that emits estimated progress during the
     * slice() phase (which is silent) and between native uploadProgress ticks.
     *
     * Caps at 92% of the chunk so it never reaches 100% artificially —
     * the real final tick after PUT resolves covers the last 8%.
     */
    private _startSyntheticTicker;
    private _uploadChunk;
}
//# sourceMappingURL=UploadEngine.d.ts.map