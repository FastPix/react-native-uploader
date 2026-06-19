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
 * ── PROGRESS REPORTING ───────────────────────────────────────────────────
 * The web SDK gets smooth progress for free from `xhr.upload.onprogress`,
 * which fires continuously as bytes leave the browser's network stack.
 *
 * RNBlobUtil's equivalent is `.uploadProgress()` (NOT `.progress()` —
 * that one reports *response* bytes received, and GCS's resumable-upload
 * PUT responses have no body, so `total` comes back as -1 and the
 * callback is effectively useless for our case — this was the root cause
 * of the "0 → 25 → 50 → 75 → 100" stepped progress).
 *
 * `.uploadProgress({ count, interval }, cb)` is also known to be
 * unreliable on iOS — some RN/RNBlobUtil version combinations fire it
 * only once, or not at all, regardless of the count/interval config
 * (see RonRadtke/react-native-blob-util#395, joltup/rn-fetch-blob#242).
 *
 * To guarantee a smooth bar regardless of native callback reliability,
 * we layer a synthetic time-based ticker on top of native progress:
 *   - Native ticks (when they arrive) are authoritative and reset the
 *     ticker's baseline.
 *   - Between native ticks (or if none arrive at all), the ticker
 *     estimates progress using the previous chunk's measured throughput,
 *     capped at 92% of the chunk so it never overtakes a real chunkSuccess.
 * ─────────────────────────────────────────────────────────────────────────
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
   * Fired continuously as bytes move through the native layer (or, when
   * native ticks are sparse/unavailable, via a synthetic time-based
   * estimate). Mirrors the web SDK's `xhr.upload.onprogress` semantics.
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

  /**
   * Reference to the active RNBlobUtil.fetch request.
   * Calling .cancel() immediately aborts the native HTTP request,
   * equivalent to xhr.abort() in the web SDK.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _activeRequest: StatefulPromise<any> | null = null;

  /** Synthetic progress ticker for the chunk currently uploading. */
  private _syntheticTicker: ReturnType<typeof setInterval> | null = null;

  /** Bytes-per-ms measured from the most recently completed chunk — seeds the next chunk's ticker. */
  private _lastThroughputBytesPerMs: number | null = null;

  /** Highest byte value emitted (native or synthetic) for the current chunk — prevents the bar from going backwards. */
  private _lastEmittedChunkBytes = 0;

  /**
   * Re-baseable origin for the synthetic ticker: (bytes, time) pair the
   * ticker extrapolates forward from. Reset on every native tick so the
   * estimate always starts "from now" using the freshest known position,
   * instead of drifting from a stale start time + stale assumed rate —
   * which previously caused the estimate to fall behind a just-received
   * native value and produce a visible back-and-forth (e.g.
   * 32% → 33% → 32% → 33%) while it caught back up.
   */
  private _tickerOriginBytes = 0;
  private _tickerOriginTime = 0;

  constructor(opts: UploadEngineOptions) {
    this._opts = opts;
  }

  setStartChunkIndex(index: number): void {
    this._startChunkIndex = index;
  }

  abort(): void {
    this._abortController.abort();
    this._activeRequest?.cancel((reason) => {
      console.log('Upload cancelled:', reason);
    });
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

    // ── Pre-flight: cleanup orphaned temp files + verify disk space ────────
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
          // RNBlobUtil.fetch surfaces cancellation as an error whose message
          // contains 'cancel' (lowercase). Check signal.aborted first —
          // that covers user abort() and network auto-pause.
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

      if (stale.length === 0) {
        return;
      }

      await Promise.all(
        stale.map((name) =>
          RNBlobUtil.fs.unlink(`${cacheDir}/${name}`).catch(() => {
            // Ignore — file may already be gone, or removable by the OS later.
          }),
        ),
      );

      console.info(
        `[FastPix] Cleaned up ${stale.length} stale temp chunk file(s) from a previous run.`,
      );
    } catch (err) {
      console.warn('[FastPix] Failed to clean up stale temp chunk files:', err);
    }
  }

  private async _checkDiskSpace(chunkBytes: number): Promise<Error | null> {
    // Require room for ~2 chunks (the chunk being written + a safety
    // margin for the slice/readFile temp file overlap) plus 10MB headroom.
    const requiredBytes = chunkBytes * 2 + 10 * 1024 * 1024;

    try {
      const stat = (await RNBlobUtil.fs.df()) as unknown as Record<string, number>;

      const freeBytes =
        typeof stat.free === 'number'
          ? stat.free
          : typeof stat.internal_free === 'number'
            ? stat.internal_free
            : null;

      if (freeBytes === null) {
        // Couldn't determine free space — don't block the upload on this.
        return null;
      }

      if (freeBytes < requiredBytes) {
        const freeMB = (freeBytes / (1024 * 1024)).toFixed(1);
        const requiredMB = (requiredBytes / (1024 * 1024)).toFixed(1);
        return new Error(
          `[FastPix] Not enough free storage on this device to continue the ` +
            `upload. Available: ${freeMB} MB, required: ~${requiredMB} MB. ` +
            'Free up space (e.g. clear app cache or delete unused files) and try again.',
        );
      }

      return null;
    } catch (err) {
      // df() not supported or failed — proceed optimistically.
      console.warn('[FastPix] Could not check free disk space:', err);
      return null;
    }
  }

  // ─── Synthetic progress ticker ─────────────────────────────────────────────
  //
  // Native uploadProgress callbacks can be sparse or entirely absent on iOS.
  // This ticker fills the gaps with a time-based estimate so the bar always
  // animates smoothly, while deferring to real native ticks whenever they
  // do arrive.

  private _clearSyntheticTicker(): void {
    if (this._syntheticTicker !== null) {
      clearInterval(this._syntheticTicker);
      this._syntheticTicker = null;
    }
  }

  /**
   * Starts a synthetic ticker for one chunk upload. Estimates how far
   * through the chunk we are by extrapolating forward from the current
   * origin (`_tickerOriginBytes` at `_tickerOriginTime`) using the previous
   * chunk's measured throughput (falling back to a conservative default
   * for the first chunk). Capped at 92% of the chunk so it never reports
   * completion before the real network response does.
   *
   * The origin is re-baselined on every native `uploadProgress` tick (see
   * `_uploadChunk`), so the synthetic estimate always extrapolates from the
   * most recent ground truth instead of drifting from a stale starting
   * point — that drift was the cause of the 32%→33%→32% oscillation.
   */
  private _startSyntheticTicker(
    chunkBytes: number,
    emit: (estimatedSentBytes: number) => void,
  ): void {
    this._clearSyntheticTicker();

    this._syntheticTicker = setInterval(() => {
      // Use last known throughput if we have it, otherwise assume a
      // conservative 2 MB/s so early progress still moves on slow links
      // without wildly overshooting on fast ones (native ticks correct
      // it the moment they arrive, via the re-baseline below).
      const assumedBytesPerMs = this._lastThroughputBytesPerMs ?? (2 * 1024 * 1024) / 1000;

      const elapsedSinceOriginMs = Date.now() - this._tickerOriginTime;
      const estimated = Math.min(
        this._tickerOriginBytes + elapsedSinceOriginMs * assumedBytesPerMs,
        chunkBytes * 0.92,
      );

      // Only let the synthetic estimate move forward, and only if it's
      // still ahead of the last value (real or synthetic) we emitted.
      if (estimated > this._lastEmittedChunkBytes) {
        this._lastEmittedChunkBytes = estimated;
        emit(estimated);
      }
    }, 300);
  }

  /**
   * Re-baselines the synthetic ticker's extrapolation origin to a fresh
   * (bytes, time) pair. Called every time a real native `uploadProgress`
   * tick arrives, so the ticker's next estimate starts from "now" instead
   * of extrapolating from a stale start time with a stale assumed rate.
   */
  private _rebaseTicker(currentBytes: number): void {
    this._tickerOriginBytes = currentBytes;
    this._tickerOriginTime = Date.now();
  }

  // ─── Chunk upload ────────────────────────────────────────────────────────────

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

    // 1. Create a temp file containing exactly [start, end) bytes.
    const tempPath =
      `${RNBlobUtil.fs.dirs.CacheDir}/fastpix_chunk_${chunk.start}_${chunk.end}` +
      `_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    let sliceSucceeded = false;
    this._lastEmittedChunkBytes = 0;
    this._rebaseTicker(0);
    const uploadStartedAt = Date.now();

    try {
      await RNBlobUtil.fs.slice(fileUri, tempPath, chunk.start, chunk.end);
      sliceSucceeded = true;

      if (signal.aborted) throw new Error('AbortError');

      const emitChunkProgress = (sentBytes: number) => {
        const bounded = Math.min(sentBytes, chunkBytes);
        onProgress(bounded, chunk.start, chunk.end, fileSizeBytes, chunk.index, totalChunks);
      };

      // Synthetic ticker fills gaps between (or in place of) native ticks.
      this._startSyntheticTicker(chunkBytes, emitChunkProgress);

      // 2. PUT the temp file as raw bytes via RNBlobUtil.fetch.
      //    NOTE: .uploadProgress() reports bytes SENT (request body) — this
      //    is the correct method for upload progress. .progress() reports
      //    bytes RECEIVED (response body), which is unusable here since GCS
      //    PUT responses for resumable uploads carry no body. Using
      //    .progress() instead of .uploadProgress() was the root cause of
      //    the stepped 0/25/50/75/100 progress bar.
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
        // Native tick — authoritative. Re-baseline the synthetic ticker's
        // (bytes, time) origin to this real value/moment so its next
        // extrapolation starts from here, instead of drifting from a
        // stale start time and over/under-shooting on the next tick.
        this._lastEmittedChunkBytes = written;
        this._rebaseTicker(written);
        emitChunkProgress(written);
      });

      this._activeRequest = request;
      const response = await request;
      this._activeRequest = null;
      this._clearSyntheticTicker();

      // Record measured throughput for this chunk to seed the next
      // chunk's synthetic ticker with a realistic rate.
      const elapsedMs = Math.max(Date.now() - uploadStartedAt, 1);
      this._lastThroughputBytesPerMs = chunkBytes / elapsedMs;

      // Fire one final progress tick at 100% of this chunk so the UI
      // reaches the exact chunk boundary before chunkSuccess fires.
      this._lastEmittedChunkBytes = chunkBytes;
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
      // 3. Always clean up the temp file.
      if (sliceSucceeded) {
        RNBlobUtil.fs.exists(tempPath)
          .then((exists) => {
            if (exists) {
              RNBlobUtil.fs.unlink(tempPath).catch((err: unknown) => {
                console.warn(`[FastPix] Failed to delete temp chunk file:`, err);
              });
            }
          })
          .catch(() => {});
      }
    }
  }
}