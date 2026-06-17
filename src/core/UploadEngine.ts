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
  onChunkAttempt: (chunkIndex: number, attemptNumber: number, totalChunkNumbers: number) => void;

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

function resumeBytesUploaded(
  startChunkIndex: number,
  chunks: ChunkMeta[],
): number {
  if (startChunkIndex === 0) return 0;
  const last = chunks[startChunkIndex - 1];
  return last ? last.end : 0;
}

// ─── UploadEngine ─────────────────────────────────────────────────────────────

export class UploadEngine {
  private readonly _opts: UploadEngineOptions;
  private _cancelSource: CancelTokenSource | null = null;
  private _abortController: AbortController = new AbortController();
  private _startChunkIndex = 0;

  /** 30s stall watchdog — cancels a chunk if no upload progress is reported. */
  private _stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly STALL_TIMEOUT_MS = 30_000;

  constructor(opts: UploadEngineOptions) {
    this._opts = opts;
  }

  setStartChunkIndex(index: number): void {
    this._startChunkIndex = index;
  }

  abort(): void {
    this._abortController.abort();
    this._cancelSource?.cancel('Upload aborted.');
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
    let bytesUploaded = resumeBytesUploaded(this._startChunkIndex, chunks);

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
          await this._uploadChunk(chunk, endpoint, fileUri, signal);

          bytesUploaded += chunk.end - chunk.start;
          onProgress(bytesUploaded, fileSizeBytes);
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
          console.warn(
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

  private _resetStallWatchdog(): void {
    this._clearStallWatchdog();
    this._stallTimer = setTimeout(() => {
      console.warn(
        `[FastPix] Upload stalled — no progress for ${this.STALL_TIMEOUT_MS / 1000}s. ` +
          'Cancelling chunk to retry.',
      );
      this._cancelSource?.cancel('Upload stalled — no bytes transferred.');
    }, this.STALL_TIMEOUT_MS);
  }

  private async _uploadChunk(
    chunk: ChunkMeta,
    endpoint: string,
    fileUri: string,
    signal: AbortSignal,
  ): Promise<void> {
    const base64Data = await this._readChunkAsBase64(fileUri, chunk.start, chunk.end);

    if (signal.aborted) {
      throw new Error('AbortError');
    }

    // Decode base64 → binary string → Uint8Array for the axios body.
    const rawBinary = RNBlobUtil.base64.decode(base64Data);
    const byteArray = Uint8Array.from(rawBinary, (c) => c.charCodeAt(0));

    this._cancelSource = axios.CancelToken.source();
    this._resetStallWatchdog();

    try {
      await axios.put(endpoint, byteArray, {
        cancelToken: this._cancelSource.token,
        signal,
        timeout: 60_000,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': buildContentRangeHeader(chunk),
          'Content-Length': String(chunk.end - chunk.start),
        },
        // GCS resumable uploads return 308 for every intermediate chunk;
        // only the final chunk gets 200/201.
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 308,

        onUploadProgress: (progressEvent) => {
          if (progressEvent.loaded > 0) {
            this._resetStallWatchdog();
          }
        },
      });
    } finally {
      this._clearStallWatchdog();
    }
  }

  private async _readChunkAsBase64(
    fileUri: string,
    start: number,
    end: number,
  ): Promise<string> {
    const tempPath = `${RNBlobUtil.fs.dirs.CacheDir}/fastpix_chunk_${start}_${end}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;

    try {
      // 1. Slice out exactly [start, end) into a small temp file.
      await RNBlobUtil.fs.slice(fileUri, tempPath, start, end);

      // 2. Read the (small) sliced file fully as base64.
      const base64 = await RNBlobUtil.fs.readFile(tempPath, 'base64');

      return base64;
    } finally {
      // 3. Always attempt cleanup, even if slice/readFile threw.
      RNBlobUtil.fs.unlink(tempPath).catch((err: unknown) => {
        console.warn(`[FastPix] Failed to delete temp chunk file ${tempPath}:`, err);
      });
    }
  }
}