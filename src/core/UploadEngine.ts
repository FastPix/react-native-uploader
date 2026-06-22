import RNBlobUtil from 'react-native-blob-util';
import type { StatefulPromise } from 'react-native-blob-util';
import type { ChunkMeta } from '../types';
import { buildContentRangeHeader, buildChunkListFromOffset } from './ChunkEngine';

// ─── Public interfaces ────────────────────────────────────────────────────────
export interface UploadEngineOptions {
  endpoint: string;
  fileUri: string;
  fileSizeBytes: number;
  chunkSizeKB: number;
  maxRetries: number;
  retryDelay: number;

  onChunkAttempt: (chunkIndex: number, attemptNumber: number, totalChunkNumbers: number) => void;

  onChunkAttemptFailure: (
    chunkIndex: number,
    attemptNumber: number,
    error: Error,
  ) => void;

  onChunkSuccess: (chunkIndex: number, newOffset: number) => void;

  onProgress: (
    sentBytes: number,
    chunkStart: number,
    chunkEnd: number,
    fileSizeBytes: number,
    chunkIndex: number,
    totalChunks: number,
  ) => void;
}

export interface EngineResult {
  success: boolean;
  error?: Error;
}

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

export class UploadEngine {
  private readonly _opts: UploadEngineOptions;
  private _abortController: AbortController = new AbortController();
  private _startOffset = 0;

  private _activeRequest: StatefulPromise<any> | null = null;

  private _syntheticTicker: ReturnType<typeof setInterval> | null = null;

  private _lastThroughputBytesPerMs: number | null = null;

  private _lastEmittedChunkBytes = 0;

  constructor(opts: UploadEngineOptions) {
    this._opts = opts;
  }

  setStartOffset(offset: number): void {
    this._startOffset = Math.max(0, offset);
  }

  abort(): void {
    this._abortController.abort();
    this._activeRequest?.cancel();
    this._activeRequest = null;
    this._clearSyntheticTicker();
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

    await this._cleanupStaleTempFiles();

    const diskError = await this._checkDiskSpace(chunkSizeKB * 1024);
    if (diskError) {
      return { success: false, error: diskError };
    }

    const chunks = buildChunkListFromOffset(fileSizeBytes, chunkSizeKB,this._startOffset);

    for (let i = 0; i < chunks.length; i++) {
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
          await this._uploadChunk(chunk, endpoint, fileUri, signal, chunks.length, onProgress);
          onChunkSuccess(chunk.index, chunk.end);
          uploaded = true;

        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isAbort =
            signal.aborted ||
            message === 'AbortError' ||
            message === 'Upload aborted.' ||
            message.toLowerCase().includes('cancel');

          if (isAbort) {
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

  private async _cleanupStaleTempFiles(): Promise<void> {
    const cacheDir = RNBlobUtil.fs.dirs.CacheDir;
    try {
      const entries = await RNBlobUtil.fs.ls(cacheDir);
      const stale = entries.filter((name) => name.startsWith('fastpix_chunk_'));
      if (stale.length === 0) return;
      await Promise.all(
        stale.map((name) =>
          RNBlobUtil.fs.unlink(`${cacheDir}/${name}`).catch(() => {}),
        ),
      );
      console.info(`[FastPix] Cleaned up ${stale.length} stale temp chunk file(s).`);
    } catch (err) {
      console.warn('[FastPix] Failed to clean up stale temp chunk files:', err);
    }
  }

  private async _checkDiskSpace(chunkBytes: number): Promise<Error | null> {
    const requiredBytes = chunkBytes * 2 + 10 * 1024 * 1024;
    try {
      const stat = (await RNBlobUtil.fs.df()) as unknown as Record<string, number>;
      const freeBytes =
        typeof stat.free === 'number'
          ? stat.free
          : typeof stat.internal_free === 'number'
            ? stat.internal_free
            : null;
      if (freeBytes === null) return null;
      if (freeBytes < requiredBytes) {
        const freeMB = (freeBytes / (1024 * 1024)).toFixed(1);
        const requiredMB = (requiredBytes / (1024 * 1024)).toFixed(1);
        return new Error(
          `[FastPix] Not enough storage. Available: ${freeMB} MB, required: ~${requiredMB} MB.`,
        );
      }
      return null;
    } catch {
      return null;
    }
  }

  private _clearSyntheticTicker(): void {
    if (this._syntheticTicker !== null) {
      clearInterval(this._syntheticTicker);
      this._syntheticTicker = null;
    }
  }

  private _startSyntheticTicker(
    chunkBytes: number,
    emit: (estimatedSentBytes: number) => void,
  ): void {
    this._clearSyntheticTicker();

    const startedAt = Date.now();
    const assumedBytesPerMs =
      this._lastThroughputBytesPerMs ?? (2 * 1024 * 1024) / 1000; // default 2 MB/s

    this._syntheticTicker = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      // Cap synthetic estimate at 92% to never overshoot before the real tick.
      const estimated = Math.min(elapsedMs * assumedBytesPerMs, chunkBytes * 0.92);
      if (estimated > this._lastEmittedChunkBytes) {
        this._lastEmittedChunkBytes = estimated;
        emit(estimated);
      }
    }, 300);
  }

  private async _uploadChunk(
    chunk: ChunkMeta,
    endpoint: string,
    fileUri: string,
    signal: AbortSignal,
    totalChunks: number,
    onProgress: (
      sentBytes: number,
      chunkStart: number,
      chunkEnd: number,
      fileSizeBytes: number,
      chunkIndex: number,
      totalChunks: number,
    ) => void,
  ): Promise<void> {
    if (signal.aborted) throw new Error('AbortError');

    const { fileSizeBytes } = this._opts;
    const chunkBytes = chunk.end - chunk.start;

    this._lastEmittedChunkBytes = 0;

    const uploadStartedAt = Date.now();

    const tempPath =
      `${RNBlobUtil.fs.dirs.CacheDir}/fastpix_chunk_${chunk.start}_${chunk.end}` +
      `_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    let sliceSucceeded = false;

    const emitChunkProgress = (sentBytes: number): void => {
      const bounded = Math.max(0, Math.min(sentBytes, chunkBytes));

      if (bounded < this._lastEmittedChunkBytes) {
        return;
      }

      this._lastEmittedChunkBytes = bounded;

      onProgress(
        bounded,
        chunk.start,
        chunk.end,
        fileSizeBytes,
        chunk.index,
        totalChunks,
      );
    };

    try {
  
      this._startSyntheticTicker(chunkBytes, emitChunkProgress);

      await RNBlobUtil.fs.slice(fileUri, tempPath, chunk.start, chunk.end);
      sliceSucceeded = true;

      this._clearSyntheticTicker();

      if (signal.aborted) throw new Error('AbortError');

      const request = RNBlobUtil.fetch(
        'PUT',
        endpoint,
        {
          'Content-Type': 'application/octet-stream',
          'Content-Range': buildContentRangeHeader(chunk),
          'Content-Length': String(chunkBytes),
        },
        RNBlobUtil.wrap(tempPath),
      ).uploadProgress({ interval: 250 }, (written: number) => {
        emitChunkProgress(written);
      });

      this._activeRequest = request;
      const response = await request;
      this._activeRequest = null;
      this._clearSyntheticTicker();

      const elapsedMs = Math.max(Date.now() - uploadStartedAt, 1);
      this._lastThroughputBytesPerMs = chunkBytes / elapsedMs;

      emitChunkProgress(chunkBytes);

      const status = response.respInfo.status;
      const isSuccess = (status >= 200 && status < 300) || status === 308;

      if (!isSuccess) {
        throw new Error(
          `[FastPix] Chunk ${chunk.index} upload failed with HTTP ${status}.`,
        );
      }
    } finally {
      this._clearSyntheticTicker();
      if (sliceSucceeded) {
        RNBlobUtil.fs.exists(tempPath)
          .then((exists) => {
            if (exists) {
              RNBlobUtil.fs.unlink(tempPath).catch((err: unknown) => {
                console.warn('[FastPix] Failed to delete temp chunk file:', err);
              });
            }
          })
          .catch(() => {});
      }
    }
  }
}