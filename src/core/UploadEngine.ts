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

// If an in-flight chunk makes no upload progress for this long, the underlying
// socket is treated as dead (e.g. a network handoff that keeps the device
// "online") and the request is cancelled so the retry logic can re-attempt the
// chunk instead of hanging forever.
const STALL_TIMEOUT_MS = 30_000;

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
    fileSizeBytes,
    chunkSizeKB,
  } = this._opts;

  await this._cleanupStaleTempFiles();

  const diskError = await this._checkDiskSpace(chunkSizeKB * 1024);
  if (diskError) {
    return { success: false, error: diskError };
  }

  const chunks = buildChunkListFromOffset(
    fileSizeBytes,
    chunkSizeKB,
    this._startOffset,
  );

  for (const chunk of chunks) {
    if (signal.aborted) {
      return { success: false, error: new Error('Upload was aborted.') };
    }

    const result = await this._uploadChunkWithRetry(chunk, chunks.length, signal);
    if (result) {
      return result;
    }
  }

  return { success: true };
}

private async _uploadChunkWithRetry(
  chunk: ChunkMeta,
  totalChunks: number,
  signal: AbortSignal,
): Promise<EngineResult | null> {
  const {
    endpoint,
    fileUri,
    onChunkAttempt,
    onChunkSuccess,
    onProgress,
  } = this._opts;

  let attempt = 0;

  while (true) {
    if (signal.aborted) {
      return this._abortedResult();
    }

    onChunkAttempt(chunk.index, attempt + 1, totalChunks);

    try {
      await this._uploadChunk(
        chunk,
        endpoint,
        fileUri,
        signal,
        totalChunks,
        onProgress,
      );

      onChunkSuccess(chunk.index, chunk.end);
      return null;
    } catch (err) {
      const result = await this._handleChunkUploadError(
        err,
        chunk,
        attempt,
        signal,
      );

      if (result?.retry) {
        attempt = result.nextAttempt;
        continue;
      }

      return result?.engineResult ?? null;
    }
  }
}

private async _handleChunkUploadError(
  err: unknown,
  chunk: ChunkMeta,
  attempt: number,
  signal: AbortSignal,
): Promise<
  | { retry: true; nextAttempt: number }
  | { retry: false; engineResult: EngineResult }
> {
  const {
    maxRetries,
    retryDelay,
    onChunkAttemptFailure,
  } = this._opts;

  if (this._isAbortError(err, signal)) {
    return {
      retry: false,
      engineResult: this._abortedResult(),
    };
  }

  const nextAttempt = attempt + 1;
  const chunkError =
    err instanceof Error ? err : new Error('Unknown chunk upload error.');

  onChunkAttemptFailure(chunk.index, nextAttempt, chunkError);

  if (nextAttempt >= maxRetries) {
    return {
      retry: false,
      engineResult: {
        success: false,
        error: new Error(
          `[FastPix] Chunk ${chunk.index} failed after ${maxRetries} retries: ${chunkError.message}`,
        ),
      },
    };
  }

  const backoffMs = retryDelay * Math.pow(2, nextAttempt - 1);
  console.warn(
    `[FastPix] Chunk ${chunk.index} failed (attempt ${nextAttempt}/${maxRetries}). ` +
      `Retrying in ${backoffMs} ms — ${chunkError.message}`,
  );

  try {
    await sleep(backoffMs, signal);
    return { retry: true, nextAttempt };
  } catch {
    return {
      retry: false,
      engineResult: {
        success: false,
        error: new Error('Upload was aborted during retry back-off.'),
      },
    };
  }
}

private _abortedResult(): EngineResult {
  return {
    success: false,
    error: new Error('Upload was aborted.'),
  };
}

private _isAbortError(err: unknown, signal: AbortSignal): boolean {
  const message = err instanceof Error ? err.message : String(err);

  return (
    signal.aborted ||
    message === 'AbortError' ||
    message === 'Upload aborted.' ||
    message.toLowerCase().includes('cancel')
  );
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

      let freeBytes: number | null = null;

      if (typeof stat.free === 'number') {
        freeBytes = stat.free;
      } else if (typeof stat.internal_free === 'number') {
        freeBytes = stat.internal_free;
      }

      if (freeBytes === null) {
        return null;
      }

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
      `_${Date.now()}_${chunk.index}`;

    let sliceSucceeded = false;

    // Stall detection: the socket can die without any error or NetInfo event
    // (network handoff). We track the last time real bytes moved and cancel the
    // request if it goes silent for too long, turning a hang into a retry.
    let stallWatchdog: ReturnType<typeof setInterval> | null = null;
    let lastProgressAt = Date.now();
    let stalled = false;

    const clearStallWatchdog = (): void => {
      if (stallWatchdog !== null) {
        clearInterval(stallWatchdog);
        stallWatchdog = null;
      }
    };

    const emitChunkProgress = (sentBytes: number): void => {
      const bounded = Math.max(0, Math.min(sentBytes, chunkBytes));

      if (bounded < this._lastEmittedChunkBytes) {
        return;
      }

      lastProgressAt = Date.now();
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

      lastProgressAt = Date.now();
      stallWatchdog = setInterval(() => {
        if (Date.now() - lastProgressAt >= STALL_TIMEOUT_MS) {
          stalled = true;
          clearStallWatchdog();
          request.cancel();
        }
      }, 1000);

      let response: Awaited<typeof request>;
      try {
        response = await request;
      } catch (err) {
        // A stall-triggered cancel must retry, not be treated as a user abort.
        if (stalled && !signal.aborted) {
          throw new Error(
            `[FastPix] Chunk ${chunk.index} stalled — no progress for ${STALL_TIMEOUT_MS} ms; will retry.`,
          );
        }
        throw err;
      } finally {
        clearStallWatchdog();
      }

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
      clearStallWatchdog();
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