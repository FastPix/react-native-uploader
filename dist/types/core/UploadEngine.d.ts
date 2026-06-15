/**
 * UploadEngine — Phase 2 (axios) — patched: slice-based chunk reading
 *
 * ── BACKGROUND ───────────────────────────────────────────────────────────
 * RNBlobUtil.fs.readStream(path, 'base64', bufferSize, position):
 *   - `bufferSize` controls bytes delivered PER onData event.
 *   - It does NOT cap the TOTAL bytes read — the stream reads to EOF
 *     regardless, and there is no working close()/pause() to stop it early
 *     (confirmed at runtime on both platforms — neither method exists on
 *     the returned stream object).
 *
 * For a 57MB file with 5MB chunks, every chunk's stream kept reading to
 * EOF in the background after the promise resolved, leaking tens of MB
 * of orphaned base64 strings per chunk. By chunk 3, ~200MB+ of dead
 * strings were alive simultaneously, exhausting memory and hanging the
 * upload indefinitely.
 *
 * ── FIX ──────────────────────────────────────────────────────────────────
 * Replace readStream entirely with RNBlobUtil.fs.slice(path, destPath,
 * start, end), which creates a small TEMP FILE containing exactly the
 * requested byte range. We then readFile() that temp file (which is only
 * ~5MB, never the whole source file) and delete it immediately after.
 *
 * This guarantees:
 *   - Exactly chunkByteLength bytes are ever read into memory.
 *   - No lingering streams, no overreading, no leaks.
 *   - Memory usage stays flat regardless of source file size.
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface UploadEngineOptions {
    endpoint: string;
    fileUri: string;
    fileSizeBytes: number;
    chunkSizeKB: number;
    maxRetries: number;
    retryDelay: number;
    /** Fired at the start of every chunk attempt (including retries). */
    onChunkAttempt: (chunkIndex: number, attemptNumber: number) => void;
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
    /**
     * Reads the chunk's byte range from disk and PUTs it to the endpoint.
     *
     * Headers sent per chunk:
     *   Content-Type:   application/octet-stream
     *   Content-Range:  bytes <start>-<end-1>/<totalSize>   (RFC 7233)
     *   Content-Length: <chunk byte count>
     */
    private _uploadChunk;
    /**
     * Read bytes [start, end) from the file and return them as a base64 string.
     *
     * ── See the file-level comment at the top of this file for background. ──
     *
     * Strategy:
     *   1. RNBlobUtil.fs.slice(fileUri, tempPath, start, end) — creates a
     *      temp file containing ONLY this chunk's bytes (~5MB, never the
     *      whole source file).
     *   2. RNBlobUtil.fs.readFile(tempPath, 'base64') — reads that small
     *      temp file fully into memory as base64. Safe because its size is
     *      bounded by chunkSize, regardless of how large the source file is.
     *   3. RNBlobUtil.fs.unlink(tempPath) — delete the temp file. Failure to
     *      delete is logged but non-fatal (OS temp dirs are cleaned up
     *      automatically and won't block the upload).
     *
     * Each call uses a unique temp filename (chunk index + random suffix) so
     * concurrent retries or overlapping calls never collide.
     */
    private _readChunkAsBase64;
}
//# sourceMappingURL=UploadEngine.d.ts.map