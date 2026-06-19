import RNBlobUtil from 'react-native-blob-util';
import type { ChunkMeta } from '../types';
import { buildContentRangeHeader, buildChunkList } from './ChunkEngine';
import { warn } from '../logger';

// ─── Public interfaces ────────────────────────────────────────────────────────

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
  onChunkAttemptFailure: (
    chunkIndex: number,
    attemptNumber: number,
    error: Error,
  ) => void;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// function resumeBytesUploaded(
//   startChunkIndex: number,
//   chunks: ChunkMeta[],
// ): number {
//   if (startChunkIndex === 0) return 0;
//   const last = chunks[startChunkIndex - 1];
//   return last ? last.end : 0;
// }

// ─── UploadEngine ─────────────────────────────────────────────────────────────

export class UploadEngine {
  private readonly _opts: UploadEngineOptions;
  private _abortController: AbortController = new AbortController();
  private _startChunkIndex = 0;

  /** 30s stall watchdog — cancels a chunk if no upload progress is reported. */
  private _stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly STALL_TIMEOUT_MS = 60_000;

  constructor(opts: UploadEngineOptions) {
    this._opts = opts;
  }

  setStartChunkIndex(index: number): void {
    this._startChunkIndex = index;
  }

  abort(): void {
    this._abortController.abort();
    this._clearStallWatchdog();
  }

  async run(): Promise<EngineResult> {
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
    // let bytesUploaded = resumeBytesUploaded(this._startChunkIndex, chunks);

    for (let i = this._startChunkIndex; i < chunks.length; i++) {
      if (signal.aborted) {
        return { success: false, error: new Error('Upload was aborted.') };
      }

      const chunk = chunks[i];
      if (!chunk) continue;

      let attempt = 0;
      let uploaded = false;

      while (!uploaded) {
        if (signal.aborted) {
          return { success: false, error: new Error('Upload was aborted.') };
        }

        onChunkAttempt(chunk.index, attempt + 1, chunks.length);

        try {
          await this._uploadChunk(chunk, endpoint, fileUri, signal, onProgress);

          // bytesUploaded = chunk.end;
          onChunkSuccess(chunk.index, chunk.end);
          uploaded = true;

        } catch (err) {
          const isUserAbort =
            signal.aborted ||
            (err instanceof Error && err.message === 'AbortError');

          if (isUserAbort) {
            return { success: false, error: new Error('Upload was aborted.') };
          }

          attempt += 1;
          const chunkError =
            err instanceof Error ? err : new Error('Unknown chunk upload error.');

          onChunkAttemptFailure(chunk.index, attempt, chunkError);

          if (attempt > maxRetries) {
            return {
              success: false,
              error: new Error(
                `[FastPix] Chunk ${chunk.index} failed after ${maxRetries} ` +
                  `retries: ${chunkError.message}`,
              ),
            };
          }

          const backoffMs = retryDelay * Math.pow(2, attempt - 1);
          warn(
            `[FastPix] Chunk ${chunk.index} failed (attempt ${attempt}/${maxRetries}). ` +
              `Retrying in ${backoffMs} ms — ${chunkError.message}`,
          );

          try {
            await sleep(backoffMs, signal);
          } catch {
            return {
              success: false,
              error: new Error('Upload was aborted during retry back-off.'),
            };
          }
        }
      }
    }

    return { success: true };
  }

  private _clearStallWatchdog(): void {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = null;
    }
  }

  /**
   * Resets the stall watchdog.
   *
   * Previously this was called once before `RNBlobUtil.fetch` and cleared
   * after it resolved — so for a 500 MB chunk taking 65 s, the 30 s timer
   * fired and called `abort()` even though bytes were actively moving through
   * the native layer.  The fix: call this on every native progress tick so
   * the timer only fires when bytes genuinely stop moving.
   */
  private _resetStallWatchdog(): void {
    this._clearStallWatchdog();
    this._stallTimer = setTimeout(() => {
      warn(
        `[FastPix] Upload stalled — no progress for ${this.STALL_TIMEOUT_MS / 1000}s. ` +
          'Aborting chunk to retry.',
      );
      this._abortController.abort();
    }, this.STALL_TIMEOUT_MS);
  }

  private async _uploadChunk(
    chunk: ChunkMeta,
    endpoint: string,
    fileUri: string,
    signal: AbortSignal,
    onProgress: (bytesUploaded: number, bytesTotal: number) => void,
  ): Promise<void> {
    // Slice the chunk to a temp file so we never pull raw bytes into the JS
    // heap — avoids the "String length exceeds limit" crash that occurs when
    // a large chunk (e.g. 500 MB) is read as base64 and then decoded back
    // to a Uint8Array inside JavaScript.
    const tempPath = `${RNBlobUtil.fs.dirs.CacheDir}/fastpix_chunk_${chunk.index}_${chunk.start}_${chunk.end}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;

    const { fileSizeBytes } = this._opts;

    try {
      // 1. Write exactly [start, end) bytes to a temp file on disk.
      await RNBlobUtil.fs.slice(fileUri, tempPath, chunk.start, chunk.end);

      if (signal.aborted) {
        throw new Error('AbortError');
      }

      // Arm the watchdog before the transfer begins.  It will be reset on
      // every native progress tick below, so it only fires when bytes
      // genuinely stop moving (true stall).
      this._resetStallWatchdog();

      // 2. Upload the temp file via RNBlobUtil's native HTTP layer.
      //    The file path never enters JS memory; only the response does.
      //
      //    .progress() gives us byte-level upload callbacks from the native
      //    layer — equivalent to xhr.upload.onprogress in the web SDK.
      //    We use them for two things:
      //      a) Reset the stall watchdog so it only fires on a genuine stall.
      //      b) Fire onProgress continuously so the UI updates in real time
      //         instead of jumping 0 % → 32 % → 64 % → 100 % at chunk
      //         boundaries.
      const response = await RNBlobUtil.fetch(
        'PUT',
        endpoint,
        {
          'Content-Type': 'application/octet-stream',
          'Content-Range': buildContentRangeHeader(chunk),
          'Content-Length': String(chunk.end - chunk.start),
        },
        RNBlobUtil.wrap(tempPath),
      ).progress({ count: 10 }, (sent: number, _total: number) => {
        // `sent` is bytes sent for this chunk so far (native layer counter).
        // Add the chunk's base offset to get a file-level byte position.
        const cumulativeBytes = chunk.start + sent;

        // a) Keep the watchdog alive as long as bytes are moving.
        this._resetStallWatchdog();

        // b) Emit a progress event with file-level cumulative counts,
        //    matching the web SDK's xhr.upload.onprogress semantics.
        onProgress(cumulativeBytes, fileSizeBytes);
      });

      this._clearStallWatchdog();

      const status = response.respInfo.status;

      // GCS resumable uploads return 308 Resume Incomplete for every
      // intermediate chunk; only the final chunk returns 200/201.
      const isSuccess = (status >= 200 && status < 300) || status === 308;
      if (!isSuccess) {
        throw new Error(
          `[FastPix] Chunk ${chunk.index} upload failed with HTTP ${status}.`,
        );
      }
    } finally {
      this._clearStallWatchdog();
      // Always clean up the temp file, even on error or abort.
      RNBlobUtil.fs.unlink(tempPath).catch((err: unknown) => {
        warn(`[FastPix] Failed to delete temp chunk file ${tempPath}:`, err);
      });
    }
  }
}