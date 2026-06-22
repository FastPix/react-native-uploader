import type { FastPixUploadOptions } from '../types';
/** Minimum chunk size allowed: 5 MB expressed in KB. */
export declare const MIN_CHUNK_SIZE_KB: number;
/** Maximum chunk size allowed: 5 MB expressed in KB. */
export declare const MAX_CHUNK_SIZE_KB: number;
/** Default chunk size: 5 MB in KB. */
export declare const DEFAULT_CHUNK_SIZE_KB: number;
/** Default maximum retry attempts per chunk. */
export declare const DEFAULT_MAX_RETRIES = 5;
/** Default initial retry delay in milliseconds. */
export declare const DEFAULT_RETRY_DELAY_MS = 1000;
export declare function validateAndNormalizeOptions(opts: FastPixUploadOptions): Required<FastPixUploadOptions>;
export declare function resolveEndpoint(endpoint: string | (() => Promise<string>)): Promise<string>;
//# sourceMappingURL=validation.d.ts.map