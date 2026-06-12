import type { ChunkMeta } from '../types';
/**
 * Builds the ordered list of chunk descriptors for a file.
 *
 * No file I/O is performed here – this produces only the byte-range
 * metadata. Actual reading is handled by the upload engine via
 * `react-native-blob-util`.
 *
 * @param fileSizeBytes - Total file size in bytes.
 * @param chunkSizeKB   - Desired chunk size in kilobytes (minimum 5 MB).
 * @returns Ordered array of `ChunkMeta` objects, last chunk may be smaller.
 */
export declare function buildChunkList(fileSizeBytes: number, chunkSizeKB: number): ChunkMeta[];
/**
 * Calculates the chunk index for a given byte offset.
 * Used when resuming to determine the next chunk to upload.
 *
 * @param resumeOffset  - The byte offset acknowledged by the server.
 * @param chunkSizeKB   - Chunk size in KB.
 * @returns The zero-based index of the next chunk to upload.
 */
export declare function chunkIndexForOffset(resumeOffset: number, chunkSizeKB: number): number;
/**
 * Builds the HTTP `Content-Range` header value for a chunk.
 *
 * Format: `bytes <start>-<end-1>/<total>`
 * Example: `bytes 0-5242879/20971520`
 */
export declare function buildContentRangeHeader(chunk: ChunkMeta): string;
//# sourceMappingURL=ChunkEngine.d.ts.map