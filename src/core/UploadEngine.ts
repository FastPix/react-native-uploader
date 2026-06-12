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

import axios from 'axios';
import type { CancelTokenSource } from 'axios';
import RNBlobUtil from 'react-native-blob-util';
import type { ChunkMeta } from '../types';
import { buildContentRangeHeader, buildChunkList } from './ChunkEngine';

// ─── Public interfaces ────────────────────────────────────────────────────────

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
  onChunkAttemptFailure: (
    chunkIndex: number,
    attemptNumber: number,
    error: Error,
  ) => void;

  /** Fired after a chunk is fully acknowledged by the server. */
  onChunkSuccess: (chunkIndex: number, newOffset: number) => void;

  /** Fired after each successful chunk with cumulative byte counts. */
  onProgress: (bytesUploaded: number, bytesTotal: number) => void;
}

export interface EngineResult {
  success: boolean;
  error?: Error;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sleeps for `ms` milliseconds.
 * Rejects immediately if the AbortSignal fires, so retry back-off
 * periods are interruptible by pause() or abort().
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('AbortError'));
    });
  });
}

/**
 * Computes the initial bytesUploaded count when resuming mid-upload.
 * We cannot simply multiply index × chunkSize because the resume offset
 * stored in _uploadedOffset is always the exact acknowledged byte boundary,
 * which avoids any rounding error from integer division.
 */
function resumeBytesUploaded(
  startChunkIndex: number,
  chunks: ChunkMeta[],
): number {
  if (startChunkIndex === 0) {
    return 0;
  }
  // The start of chunk N equals the end of chunk N-1, which is the exact
  // byte offset that was last acknowledged.
  const lastAcknowledgedChunk = chunks[startChunkIndex - 1];
  return lastAcknowledgedChunk ? lastAcknowledgedChunk.end : 0;
}

// ─── UploadEngine ─────────────────────────────────────────────────────────────

export class UploadEngine {
  private readonly _opts: UploadEngineOptions;
  private _cancelSource: CancelTokenSource | null = null;
  private _abortController: AbortController = new AbortController();
  private _startChunkIndex = 0;

  constructor(opts: UploadEngineOptions) {
    this._opts = opts;
    console.log('[FastPix:UploadEngine] Constructor initialized', {
      timestamp: new Date().toISOString(),
      chunkSizeKB: opts.chunkSizeKB,
      fileSizeBytes: opts.fileSizeBytes,
      maxRetries: opts.maxRetries,
      retryDelay: opts.retryDelay,
    });
  }

  /**
   * Set the chunk index to start or resume from.
   * Called by FastPixUpload after calculating chunkIndexForOffset().
   */
  setStartChunkIndex(index: number): void {
    console.log('[FastPix:UploadEngine] setStartChunkIndex() called', {
      timestamp: new Date().toISOString(),
      startChunkIndex: index,
    });
    this._startChunkIndex = index;
  }

  /**
   * Abort the in-progress upload immediately.
   * Cancels both the axios request and any active sleep() during back-off.
   */
  abort(): void {
    console.log('[FastPix:UploadEngine] abort() called', {
      timestamp: new Date().toISOString(),
    });
    this._abortController.abort();
    this._cancelSource?.cancel('Upload aborted.');
  }

  /**
   * Run the sequential chunk upload loop from _startChunkIndex.
   *
   * Returns { success: true } when all chunks are acknowledged.
   * Returns { success: false, error } on abort or non-recoverable failure.
   * Never throws — the caller (FastPixUpload._runEngine) inspects the result.
   */
  async run(): Promise<EngineResult> {
    const runStartTime = Date.now();
    console.log('[FastPix:UploadEngine] run() starting', {
      timestamp: new Date().toISOString(),
      startChunkIndex: this._startChunkIndex,
    });

    // Fresh AbortController for each run() so resume() works after abort().
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    const {
      endpoint,
      fileUri,
      fileSizeBytes,
      chunkSizeKB,
      maxRetries,
      retryDelay,
      onChunkAttempt,
      onChunkAttemptFailure,
      onChunkSuccess,
      onProgress,
    } = this._opts;

    const chunks = buildChunkList(fileSizeBytes, chunkSizeKB);
    let bytesUploaded = resumeBytesUploaded(this._startChunkIndex, chunks);
    
    console.log('[FastPix:UploadEngine] Chunk list built', {
      totalChunks: chunks.length,
      startChunk: this._startChunkIndex,
      startingBytesUploaded: bytesUploaded,
      chunkCount: chunks.length,
    });

    for (let i = this._startChunkIndex; i < chunks.length; i++) {
      // ── Abort check before starting each chunk ──────────────────────────
      if (signal.aborted) {
        const elapsed = Date.now() - runStartTime;
        console.log('[FastPix:UploadEngine] Upload aborted before chunk', {
          chunksProcessed: i - this._startChunkIndex,
          currentChunk: i,
          duration: `${elapsed}ms`,
        });
        return { success: false, error: new Error('Upload was aborted.') };
      }

      const chunk = chunks[i];
      if (!chunk) {
        // Should never happen — guard satisfies strict noUncheckedIndexedAccess.
        continue;
      }

      const chunkStartTime = Date.now();
      console.log('[FastPix:UploadEngine] Starting chunk upload', {
        chunkIndex: chunk.index,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        chunkSize: chunk.end - chunk.start,
        uploadedSoFar: bytesUploaded,
        totalBytes: fileSizeBytes,
      });

      // ── Per-chunk retry loop ────────────────────────────────────────────
      let attempt = 0;
      let uploaded = false;

      while (!uploaded) {
        if (signal.aborted) {
          const elapsed = Date.now() - runStartTime;
          console.log('[FastPix:UploadEngine] Upload aborted during chunk retry', {
            chunk: i,
            attempt,
            duration: `${elapsed}ms`,
          });
          return { success: false, error: new Error('Upload was aborted.') };
        }

        onChunkAttempt(chunk.index, attempt + 1);

        try {
          const attemptStartTime = Date.now();
          await this._uploadChunk(chunk, endpoint, fileUri, signal);
          const attemptDuration = Date.now() - attemptStartTime;

          // ── Chunk succeeded ─────────────────────────────────────────────
          bytesUploaded += chunk.end - chunk.start;
          const progressPercent = Math.round((bytesUploaded / fileSizeBytes) * 100);
          const chunkDuration = Date.now() - chunkStartTime;
          
          console.log('[FastPix:UploadEngine] Chunk uploaded successfully', {
            chunkIndex: chunk.index,
            attempt: attempt + 1,
            attemptDuration: `${attemptDuration}ms`,
            totalChunkDuration: `${chunkDuration}ms`,
            bytesUploaded,
            progressPercent,
          });
          
          onProgress(bytesUploaded, fileSizeBytes);
          onChunkSuccess(chunk.index, chunk.end);
          uploaded = true;

        } catch (err) {
          // ── Abort / cancel — do not retry ───────────────────────────────
          const isAbort =
            axios.isCancel(err) ||
            signal.aborted ||
            (err instanceof Error && err.message === 'AbortError');

          if (isAbort) {
            const elapsed = Date.now() - runStartTime;
            console.log('[FastPix:UploadEngine] Upload cancelled', {
              chunk: i,
              attempt: attempt + 1,
              duration: `${elapsed}ms`,
            });
            return {
              success: false,
              error: new Error('Upload was aborted.'),
            };
          }

          // ── Retriable failure ───────────────────────────────────────────
          attempt += 1;
          const chunkError =
            err instanceof Error
              ? err
              : new Error('Unknown chunk upload error.');

          onChunkAttemptFailure(chunk.index, attempt, chunkError);

          console.log('[FastPix:UploadEngine] Chunk upload failed', {
            chunkIndex: chunk.index,
            attempt,
            error: chunkError.message,
            willRetry: attempt <= maxRetries,
          });

          if (attempt > maxRetries) {
            const elapsed = Date.now() - runStartTime;
            console.log('[FastPix:UploadEngine] Max retries exceeded', {
              chunk: chunk.index,
              maxRetries,
              duration: `${elapsed}ms`,
            });
            return {
              success: false,
              error: new Error(
                `[FastPix] Chunk ${chunk.index} failed after ${maxRetries} ` +
                  `retries: ${chunkError.message}`,
              ),
            };
          }

          // Exponential back-off: delay × 2^(attempt-1)
          // attempt=1 → delay×1, attempt=2 → delay×2, attempt=3 → delay×4 …
          const backoffMs = retryDelay * Math.pow(2, attempt - 1);
          console.warn(
            `[FastPix] Chunk ${chunk.index} failed (attempt ${attempt}/${maxRetries}). ` +
              `Retrying in ${backoffMs} ms — ${chunkError.message}`,
          );
          console.log('[FastPix:UploadEngine] Starting retry back-off', {
            chunkIndex: chunk.index,
            attempt,
            backoffMs,
          });

          try {
            await sleep(backoffMs, signal);
          } catch {
            // sleep() throws 'AbortError' when the signal fires mid-wait.
            const elapsed = Date.now() - runStartTime;
            console.log('[FastPix:UploadEngine] Aborted during back-off', {
              duration: `${elapsed}ms`,
            });
            return {
              success: false,
              error: new Error('Upload was aborted during retry back-off.'),
            };
          }
        }
      }
    }

    const totalDuration = Date.now() - runStartTime;
    console.log('[FastPix:UploadEngine] run() completed successfully', {
      timestamp: new Date().toISOString(),
      totalDuration: `${totalDuration}ms`,
      totalChunks: chunks.length,
      totalBytes: fileSizeBytes,
    });

    return { success: true };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

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
  private async _uploadChunk(
    chunk: ChunkMeta,
    endpoint: string,
    fileUri: string,
    signal: AbortSignal,
  ): Promise<void> {
    const uploadStartTime = Date.now();
    console.log('[FastPix:UploadEngine] _uploadChunk() starting', {
      chunkIndex: chunk.index,
      start: chunk.start,
      end: chunk.end,
      size: chunk.end - chunk.start,
    });

    // Read chunk from disk
    const readStartTime = Date.now();
    const base64Data = await this._readChunkAsBase64(
      fileUri,
      chunk.start,
      chunk.end,
    );
    const readDuration = Date.now() - readStartTime;
    console.log('[FastPix:UploadEngine] Chunk read from disk', {
      duration: `${readDuration}ms`,
      base64Length: base64Data.length,
    });

    // Decode base64 → raw byte string, then wrap in Uint8Array so axios
    // sends it as binary rather than a UTF-16 JS string.
    const decodedStartTime = Date.now();
    const rawBinary = RNBlobUtil.base64.decode(base64Data);
    const byteArray = Uint8Array.from(rawBinary, (c) => c.charCodeAt(0));
    const decodedDuration = Date.now() - decodedStartTime;
    console.log('[FastPix:UploadEngine] Chunk decoded', {
      duration: `${decodedDuration}ms`,
      byteArrayLength: byteArray.length,
    });

    this._cancelSource = axios.CancelToken.source();

    const contentRange = buildContentRangeHeader(chunk);
    const contentLength = String(chunk.end - chunk.start);

    console.log('[FastPix:UploadEngine] Sending PUT request', {
      contentRange,
      contentLength,
      timestamp: new Date().toISOString(),
    });

    const requestStartTime = Date.now();
    try {
      const response = await axios.put(endpoint, byteArray, {
        cancelToken: this._cancelSource.token,
        signal,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': contentRange,
          'Content-Length': contentLength,
        },
        // Do NOT let axios throw on 308 Resume Incomplete —
        // FastPix / GCS resumable uploads return 308 after every intermediate
        // chunk; only the final chunk gets a 200/201.
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 308,
      });
      const requestDuration = Date.now() - requestStartTime;
      const totalDuration = Date.now() - uploadStartTime;
      
      console.log('[FastPix:UploadEngine] PUT request completed', {
        chunkIndex: chunk.index,
        status: response.status,
        requestDuration: `${requestDuration}ms`,
        totalDuration: `${totalDuration}ms`,
      });
    } catch (err) {
      const requestDuration = Date.now() - requestStartTime;
      console.log('[FastPix:UploadEngine] PUT request failed', {
        chunkIndex: chunk.index,
        duration: `${requestDuration}ms`,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

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
  private _readChunkAsBase64(
    fileUri: string,
    start: number,
    end: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const streamStartTime = Date.now();
      const chunkByteLength = end - start;
      let base64Accumulator = '';
      let bytesRead = 0;
      let dataEventsCount = 0;

      console.log('[FastPix:UploadEngine] Opening file stream', {
        start,
        end,
        chunkByteLength,
      });

      RNBlobUtil.fs
        .readStream(
          fileUri,
          'base64',
          chunkByteLength, // bufferSize — read at most this many bytes per event
          start,           // position  — seek to this offset before reading
        )
        .then((stream) => {
          console.log('[FastPix:UploadEngine] File stream opened', {
            duration: `${Date.now() - streamStartTime}ms`,
          });

          stream.open();

          stream.onData((data) => {
            const chunk = data as string;
            base64Accumulator += chunk;
            dataEventsCount += 1;

            // Each base64 char represents 6 bits; 4 chars = 3 bytes.
            // Approximate bytes read from the accumulated base64 length.
            bytesRead = Math.floor((base64Accumulator.length * 3) / 4);

            console.log('[FastPix:UploadEngine] Stream data event', {
              eventNumber: dataEventsCount,
              chunkSize: chunk.length,
              bytesRead,
              targetBytes: chunkByteLength,
              progress: Math.round((bytesRead / chunkByteLength) * 100),
            });

            if (bytesRead >= chunkByteLength) {
              // We have all the bytes we need — resolve without waiting for
              // the stream's natural end, which may read slightly beyond
              // the chunk boundary on some platforms.
              console.log('[FastPix:UploadEngine] Stream read complete', {
                duration: `${Date.now() - streamStartTime}ms`,
                totalDataEvents: dataEventsCount,
                bytesRead,
                base64Length: base64Accumulator.length,
              });
              resolve(base64Accumulator);
            }
          });

          stream.onError((err) => {
            console.log('[FastPix:UploadEngine] Stream error', {
              error: String(err),
              duration: `${Date.now() - streamStartTime}ms`,
            });
            reject(new Error(String(err)));
          });

          // onEnd fires after all data has been emitted normally.
          stream.onEnd(() => {
            console.log('[FastPix:UploadEngine] Stream ended naturally', {
              duration: `${Date.now() - streamStartTime}ms`,
              bytesRead,
            });
            resolve(base64Accumulator);
          });
        })
        .catch((err: unknown) => {
          console.log('[FastPix:UploadEngine] Failed to open file stream', {
            error: String(err),
            duration: `${Date.now() - streamStartTime}ms`,
          });
          reject(
            err instanceof Error
              ? err
              : new Error(`[FastPix] Failed to open file stream: ${String(err)}`),
          );
        });
    });
  }
}
