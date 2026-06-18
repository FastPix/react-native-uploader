import { log } from '../logger';
import type { FastPixUploadOptions } from '../types';

/** Minimum chunk size allowed: 5 MB expressed in KB. */
export const MIN_CHUNK_SIZE_KB = 5 * 1024;

export const MAX_CHUNK_SIZE_KB = 500 * 1024; // 500 MB in KB

/** Default chunk size: 5 MB in KB (same as web SDK minimum). */
export const DEFAULT_CHUNK_SIZE_KB = 5 * 1024;

/** Default maximum retry attempts per chunk. */
export const DEFAULT_MAX_RETRIES = 5;

/** Default initial retry delay in milliseconds. */
export const DEFAULT_RETRY_DELAY_MS = 1000;

export function validateAndNormalizeOptions(
  opts: FastPixUploadOptions,
): Required<FastPixUploadOptions> {
  log('[FastPix:validation] validateAndNormalizeOptions() starting', {
    timestamp: new Date().toISOString(),
    hasEndpoint: !!opts?.endpoint,
    hasFileUri: !!opts?.fileUri,
  });

  if (!opts) {
    throw new Error('[FastPix] Options object is required.');
  }

  // ── endpoint ────────────────────────────────────────────────────────────
  if (!opts.endpoint) {
    throw new Error(
      '[FastPix] "endpoint" is required. Provide a signed upload URL or ' +
        'an async function that resolves to one.',
    );
  }

  const endpointType = typeof opts.endpoint;
  if (endpointType !== 'string' && endpointType !== 'function') {
    throw new Error(
      '[FastPix] "endpoint" must be a string URL or an async function ' +
        'that resolves to a string URL.',
    );
  }

  // ── fileUri ─────────────────────────────────────────────────────────────
  if (!opts.fileUri || typeof opts.fileUri !== 'string') {
    throw new Error(
      '[FastPix] "fileUri" is required and must be a string ' +
        '(e.g. "file:///path/to/video.mp4").',
    );
  }

  // ── chunkSize ────────────────────────────────────────────────────────────
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE_KB;
  if (typeof chunkSize !== 'number' || !Number.isFinite(chunkSize)) {
    throw new Error('[FastPix] "chunkSize" must be a finite number (in KB).');
  }
  if (chunkSize < MIN_CHUNK_SIZE_KB) {
    throw new Error(
      `[FastPix] "chunkSize" must be at least ${MIN_CHUNK_SIZE_KB} KB (5 MB). ` +
        `Received: ${chunkSize} KB.`,
    );
  }

  if (chunkSize > MAX_CHUNK_SIZE_KB) {
    throw new TypeError(
      `Chunk size cannot exceed 500MB (512000 KB). Current chunk size: ${chunkSize} KB.`
    );
  }

  // ── maxRetries ───────────────────────────────────────────────────────────
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(
      '[FastPix] "maxRetries" must be a non-negative integer.',
    );
  }

  // ── retryDelay ───────────────────────────────────────────────────────────
  const retryDelay = opts.retryDelay ?? DEFAULT_RETRY_DELAY_MS;
  if (typeof retryDelay !== 'number' || retryDelay < 0) {
    throw new Error(
      '[FastPix] "retryDelay" must be a non-negative number (milliseconds).',
    );
  }

  const autoHandleNetworkEvents = opts.autoHandleNetworkEvents ?? true;

  const maxFileSize = opts.maxFileSize ?? 0; // 0 = no limit
  if (typeof maxFileSize !== 'number' || maxFileSize < 0) {
    throw new Error(
      '[FastPix] "maxFileSize" must be a non-negative number (bytes). ' +
        'Example: 100 * 1024 * 1024 for 100 MB.',
    );
  }


  const normalized = {
    endpoint: opts.endpoint,
    fileUri: opts.fileUri,
    chunkSize,
    maxRetries,
    retryDelay,
    maxFileSize,
    autoHandleNetworkEvents,
  };

  log('[FastPix:validation] Options normalized successfully', {
    endpoint: typeof opts.endpoint === 'function' ? 'factory-function' : 'static-url',
    fileUri: opts.fileUri.substring(0, 50),
    chunkSize,
    chunkSizeMB: (chunkSize / 1024).toFixed(2),
    maxRetries,
    retryDelay,
    autoHandleNetworkEvents,
  });

  return normalized;
}

export async function resolveEndpoint(
  endpoint: string | (() => Promise<string>),
): Promise<string> {
  const resolveStartTime = Date.now();
  log('[FastPix:validation] resolveEndpoint() starting', {
    timestamp: new Date().toISOString(),
    endpointType: typeof endpoint,
  });

  if (typeof endpoint === 'function') {
    try {
      log('[FastPix:validation] Calling endpoint factory function', {
        timestamp: new Date().toISOString(),
      });
      const url = await endpoint();
      const duration = Date.now() - resolveStartTime;
      
      if (typeof url !== 'string' || !url) {
        throw new Error(
          '[FastPix] The endpoint factory function must resolve to a non-empty string URL.',
        );
      }
      
      log('[FastPix:validation] Endpoint factory resolved', {
        duration: `${duration}ms`,
        urlLength: url.length,
        urlPreview: url.substring(0, 50) + '...',
      });
      
      return url;
    } catch (err) {
      log('[FastPix:validation] Endpoint factory failed', {
        error: err instanceof Error ? err.message : String(err),
        duration: `${Date.now() - resolveStartTime}ms`,
      });
      throw err;
    }
  }

  const duration = Date.now() - resolveStartTime;
  log('[FastPix:validation] Static endpoint used', {
    duration: `${duration}ms`,
    urlLength: endpoint.length,
    urlPreview: endpoint.substring(0, 50) + '...',
  });

  return endpoint;
}
