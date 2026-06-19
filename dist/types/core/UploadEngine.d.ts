/**
 * UploadEngine — native binary upload via RNBlobUtil.fetch
 *
 * ── ARCHITECTURE (mirrors the web SDK) ───────────────────────────────────
 * The web SDK uses File.slice() → Blob → XHR body. The Blob is sent as raw
 * bytes by the browser's network stack — no base64, no JS memory for the
 * chunk body.
 *
 * This SDK mirrors that approach for React Native:
 *   1. RNBlobUtil.fs.slice(src, tempPath, start, end)
 *      → creates a temp file containing exactly [start, end) bytes.
 *        Equivalent to file.slice(start, end) in the web SDK.
 *   2. RNBlobUtil.fetch('PUT', url, headers, { path: tempPath })
 *      → sends the temp file as raw bytes from native code (ObjC/Java).
 *        The JS thread never touches the binary data.
 *        Equivalent to xhr.send(blob) in the web SDK.
 *   3. Delete the temp file after the PUT resolves.
 *
 * ── WHY NOT axios + base64 ────────────────────────────────────────────────
 * The previous approach:
 *   slice() → readFile('base64') → base64.decode() → Uint8Array.from() → axios.put()
 *
 * For a 500 MB chunk this creates simultaneously:
 *   ~667 MB base64 string  (JS heap)
 *   ~500 MB Uint8Array     (JS heap)
 *   ──────────────────────────────
 *   ~1.2 GB JS strings/buffers
 *
 * Hermes caps string length at ~512 MB → "String length exceeds limit" crash.
 * Even below that limit, GC pressure causes stalls on large chunks.
 *
 * With RNBlobUtil.fetch({ path }) the file is read and sent entirely in
 * native code. JS heap impact = 0 bytes for the chunk body, regardless of
 * chunk size. 500 MB chunks work fine.
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
    onProgress: (sentBytes: number, chunkStart: number, chunkEnd: number, fileSizeBytes: number, chunkIndex: number, totalChunks: number) => void;
}
export interface EngineResult {
    success: boolean;
    error?: Error;
}
export declare class UploadEngine {
    private readonly _opts;
    private _abortController;
    private _startChunkIndex;
    /**
   * Reference to the active RNBlobUtil.fetch request.
   * Calling .cancel() immediately aborts the native HTTP request,
   * equivalent to xhr.abort() in the web SDK.
   */
    private _activeRequest;
    /** Synthetic progress ticker for the chunk currently uploading. */
    private _syntheticTicker;
    /** Bytes-per-ms measured from the most recently completed chunk. */
    private _lastThroughputBytesPerMs;
    /** Highest byte value emitted (native or synthetic) for the current chunk — prevents the bar from going backwards. */
    private _lastEmittedChunkBytes;
    constructor(opts: UploadEngineOptions);
    setStartChunkIndex(index: number): void;
    abort(): void;
    run(): Promise<EngineResult>;
    private _cleanupStaleTempFiles;
    private _checkDiskSpace;
    private _clearSyntheticTicker;
    private _startSyntheticTicker;
    private _uploadChunk;
}
//# sourceMappingURL=UploadEngine.d.ts.map