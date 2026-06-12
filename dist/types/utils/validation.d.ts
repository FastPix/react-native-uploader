import type { FastPixUploadOptions } from '../types';
/** Minimum chunk size allowed: 5 MB expressed in KB. */
export declare const MIN_CHUNK_SIZE_KB: number;
/** Default chunk size: 5 MB in KB (same as web SDK minimum). */
export declare const DEFAULT_CHUNK_SIZE_KB: number;
/** Default maximum retry attempts per chunk. */
export declare const DEFAULT_MAX_RETRIES = 5;
/** Default initial retry delay in milliseconds. */
export declare const DEFAULT_RETRY_DELAY_MS = 1000;
/**
 * Validates the options passed to `FastPixUpload` and returns a
 * normalised, fully-resolved config with all defaults applied.
 *
 * Throws a descriptive `Error` if required fields are missing or
 * constraint violations are detected, matching the web SDK's
 * validation philosophy.
 */
export declare function validateAndNormalizeOptions(opts: FastPixUploadOptions): Required<FastPixUploadOptions>;
/**
 * Resolves the endpoint option to a plain string URL.
 * Handles both static strings and async factory functions.
 */
export declare function resolveEndpoint(endpoint: string | (() => Promise<string>)): Promise<string>;
//# sourceMappingURL=validation.d.ts.map