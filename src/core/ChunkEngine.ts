import type { ChunkMeta } from '../types';
import { MIN_CHUNK_SIZE_KB } from '../utils/validation';

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
export function buildChunkList(
  fileSizeBytes: number,
  chunkSizeKB: number,
): ChunkMeta[] {
  console.log('[FastPix:ChunkEngine] buildChunkList() called', {
    timestamp: new Date().toISOString(),
    fileSizeBytes,
    fileSizeMB: (fileSizeBytes / (1024 * 1024)).toFixed(2),
    chunkSizeKB,
    chunkSizeMB: (chunkSizeKB / 1024).toFixed(2),
  });

  if (fileSizeBytes <= 0) {
    throw new Error('[FastPix] File size must be greater than 0 bytes.');
  }

  const chunkSizeBytes = chunkSizeKB * 1024;

  if (chunkSizeBytes < MIN_CHUNK_SIZE_KB * 1024) {
    throw new Error(
      `[FastPix] chunkSize must be at least ${MIN_CHUNK_SIZE_KB} KB.`,
    );
  }

  const chunks: ChunkMeta[] = [];
  let offset = 0;
  let index = 0;

  while (offset < fileSizeBytes) {
    const end = Math.min(offset + chunkSizeBytes, fileSizeBytes);
    chunks.push({
      index,
      start: offset,
      end,
      totalSize: fileSizeBytes,
    });
    offset = end;
    index += 1;
  }

  console.log('[FastPix:ChunkEngine] Chunk list created', {
    totalChunks: chunks.length,
    firstChunkSize: chunks[0] ? chunks[0].end - chunks[0].start : 0,
    lastChunkSize: chunks[chunks.length - 1] ? chunks[chunks.length - 1].end - chunks[chunks.length - 1].start : 0,
    totalBytes: fileSizeBytes,
  });

  return chunks;
}

/**
 * Calculates the chunk index for a given byte offset.
 * Used when resuming to determine the next chunk to upload.
 *
 * @param resumeOffset  - The byte offset acknowledged by the server.
 * @param chunkSizeKB   - Chunk size in KB.
 * @returns The zero-based index of the next chunk to upload.
 */
export function chunkIndexForOffset(
  resumeOffset: number,
  chunkSizeKB: number,
): number {
  const chunkSizeBytes = chunkSizeKB * 1024;
  const index = Math.floor(resumeOffset / chunkSizeBytes);
  
  console.log('[FastPix:ChunkEngine] chunkIndexForOffset() calculated', {
    resumeOffset,
    chunkSizeKB,
    chunkSizeBytes,
    calculatedIndex: index,
  });
  
  return index;
}

/**
 * Builds the HTTP `Content-Range` header value for a chunk.
 *
 * Format: `bytes <start>-<end-1>/<total>`
 * Example: `bytes 0-5242879/20971520`
 */
export function buildContentRangeHeader(chunk: ChunkMeta): string {
  const headerValue = `bytes ${chunk.start}-${chunk.end - 1}/${chunk.totalSize}`;
  
  console.log('[FastPix:ChunkEngine] buildContentRangeHeader() created', {
    chunkIndex: chunk.index,
    start: chunk.start,
    end: chunk.end - 1,
    total: chunk.totalSize,
    headerValue,
  });
  
  return headerValue;
}
