import type { ChunkMeta } from '../types';
import { MIN_CHUNK_SIZE_KB } from '../utils/validation';

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
