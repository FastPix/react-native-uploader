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

import RNBlobUtil from 'react-native-blob-util';
import type { StatefulPromise } from 'react-native-blob-util';
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

  onChunkAttempt: (chunkIndex: number, attemptNumber: number, totalChunkNumbers: number) => void;

  onChunkAttemptFailure: (
    chunkIndex: number,
    attemptNumber: number,
    error: Error,
  ) => void;

  onChunkSuccess: (chunkIndex: number, newOffset: number) => void;

  /**
   * Fired continuously as bytes move through the native layer.
   * sentBytes resets to 0 at the start of each new chunk.
   */
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

// ─── UploadEngine ─────────────────────────────────────────────────────────────

export class UploadEngine {
  private readonly _opts: UploadEngineOptions;
  private _abortController: AbortController = new AbortController();
  private _startChunkIndex = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _activeRequest: StatefulPromise<any> | null = null;

  /** Synthetic progress ticker for the chunk currently uploading. */
  private _syntheticTicker: ReturnType<typeof setInterval> | null = null;

  /** Bytes-per-ms measured from the most recently completed chunk. */
  private _lastThroughputBytesPerMs: number | null = null;

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
  private _lastEmittedChunkBytes = 0;

  constructor(opts: UploadEngineOptions) {
    this._opts = opts;
  }

  setStartChunkIndex(index: number): void {
    this._startChunkIndex = index;
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

    const chunks = buildChunkList(fileSizeBytes, chunkSizeKB);

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

  // ── Private: pre-flight ───────────────────────────────────────────────────

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

  // ── Private: synthetic progress ticker ───────────────────────────────────

  private _clearSyntheticTicker(): void {
    if (this._syntheticTicker !== null) {
      clearInterval(this._syntheticTicker);
      this._syntheticTicker = null;
    }
  }

  /**
   * Starts a 300ms interval that emits estimated progress during the
   * slice() phase (which is silent) and between native uploadProgress ticks.
   *
   * Caps at 92% of the chunk so it never reaches 100% artificially —
   * the real final tick after PUT resolves covers the last 8%.
   */
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

  // ── Private: chunk upload ─────────────────────────────────────────────────

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

    // ── CRITICAL: reset per-chunk state BEFORE anything else ────────────────
    // _lastEmittedChunkBytes must be 0 at the start of every chunk.
    // If it holds chunk N-1's final value, the monotonic guard blocks
    // ALL progress events for chunk N until native ticks exceed the old
    // ceiling — causing the oscillation between chunk N-1's % and N's %.
    this._lastEmittedChunkBytes = 0;
    // ─────────────────────────────────────────────────────────────────────────

    const uploadStartedAt = Date.now();

    const tempPath =
      `${RNBlobUtil.fs.dirs.CacheDir}/fastpix_chunk_${chunk.start}_${chunk.end}` +
      `_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    let sliceSucceeded = false;

    // Helper: monotonic emit — never goes backwards within a chunk.
    const emitChunkProgress = (sentBytes: number): void => {
      const bounded = Math.max(0, Math.min(sentBytes, chunkBytes));
      if (bounded > this._lastEmittedChunkBytes) {
        this._lastEmittedChunkBytes = bounded;
      }
      // Always call onProgress even if bounded equals _lastEmittedChunkBytes
      // so the final 100% tick fires even when the previous tick was 100%.
      onProgress(this._lastEmittedChunkBytes, chunk.start, chunk.end, fileSizeBytes, chunk.index, totalChunks);
    };

    try {
      // Start synthetic ticker immediately — covers the slice() phase which
      // is silent but can take several seconds for large chunks on slow I/O.
      this._startSyntheticTicker(chunkBytes, emitChunkProgress);

      // 1. Slice the chunk to a temp file (no JS heap allocation for the data).
      await RNBlobUtil.fs.slice(fileUri, tempPath, chunk.start, chunk.end);
      sliceSucceeded = true;

      if (signal.aborted) throw new Error('AbortError');

      // 2. PUT via RNBlobUtil native HTTP.
      //    uploadProgress reports bytes SENT (request body) — correct for
      //    upload tracking. .progress() reports bytes RECEIVED (response
      //    body) — useless here since GCS PUT responses carry no body.
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
        // Real native tick — update the monotonic ceiling and emit.
        if (written > this._lastEmittedChunkBytes) {
          this._lastEmittedChunkBytes = written;
        }
        emitChunkProgress(written);
      });

      this._activeRequest = request;
      const response = await request;
      this._activeRequest = null;
      this._clearSyntheticTicker();

      // Record throughput for this chunk to seed the next chunk's ticker.
      const elapsedMs = Math.max(Date.now() - uploadStartedAt, 1);
      this._lastThroughputBytesPerMs = chunkBytes / elapsedMs;

      // Final 100% tick — ensures the UI hits the exact chunk boundary
      // before chunkSuccess fires, regardless of the last native tick value.
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