/**
 * UploadEngine  — Phase 2
 *
 * Handles the low-level mechanics of uploading a single file in sequential
 * chunks to a FastPix resumable upload endpoint.
 *
 * Responsibilities:
 *   - Reading byte-range slices from disk via react-native-blob-util
 *   - Building correct HTTP headers (Content-Range, Content-Type)
 *   - Sending chunks sequentially with axios
 *   - Exponential back-off retry on transient failures
 *   - Surfacing progress, chunkAttempt, chunkAttemptFailure, and
 *     chunkSuccess events to the parent FastPixUpload class
 *
 * What this class does NOT do:
 *   - State machine management  →  FastPixUpload
 *   - Network connectivity      →  NetworkMonitor
 *   - Event fan-out             →  TypedEventEmitter (owned by FastPixUpload)
 *
 * react-native-blob-util file reading strategy:
 *   We use `readStream` with bufferSize = chunkSizeBytes and a start
 *   offset so only one chunk worth of bytes is loaded into memory at
 *   a time, keeping the footprint flat for very large video files.
 *   The stream emits base64-encoded data events which we accumulate
 *   and then decode to a Uint8Array for the axios PUT body.
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
    constructor(opts: UploadEngineOptions);
    /**
     * Set the chunk index to start or resume from.
     * Called by FastPixUpload after calculating chunkIndexForOffset().
     */
    setStartChunkIndex(index: number): void;
    /**
     * Abort the in-progress upload immediately.
     * Cancels both the axios request and any active sleep() during back-off.
     */
    abort(): void;
    /**
     * Run the sequential chunk upload loop from _startChunkIndex.
     *
     * Returns { success: true } when all chunks are acknowledged.
     * Returns { success: false, error } on abort or non-recoverable failure.
     * Never throws — the caller (FastPixUpload._runEngine) inspects the result.
     */
    run(): Promise<EngineResult>;
    /**
     * Reads the chunk's byte range from disk and PUTs it to the endpoint.
     *
     * The file is never fully loaded into memory. react-native-blob-util's
     * readStream opens a native stream, emitting base64-encoded chunks into
     * JS. We accumulate the base64 string, decode it to raw bytes, and hand
     * those bytes to axios as a Uint8Array body.
     *
     * Headers sent per chunk:
     *   Content-Type:  application/octet-stream
     *   Content-Range: bytes <start>-<end-1>/<totalSize>   (RFC 7233)
     *   Content-Length: <chunk byte count>
     */
    private _uploadChunk;
    /**
     * Reads bytes [start, end) from `fileUri` and returns them as a
     * base64-encoded string using react-native-blob-util's streaming API.
     *
     * Using a stream (rather than readFile on the whole file) keeps memory
     * usage constant regardless of total file size.
     *
     * readStream(path, encoding, bufferSize, position)
     *   - encoding   'base64'   → each onData event is a base64 string
     *   - bufferSize            → max bytes read per event (= chunk size)
     *   - position              → start byte offset in the file
     *
     * We close the stream as soon as we've read exactly (end - start) bytes
     * to avoid over-reading into the next chunk's territory.
     */
    private _readChunkAsBase64;
}
//# sourceMappingURL=UploadEngine.d.ts.map