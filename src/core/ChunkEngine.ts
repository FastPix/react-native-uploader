import { log } from '../logger';
import type { ChunkMeta } from '../types';
import { MIN_CHUNK_SIZE_KB } from '../utils/validation';

export function buildChunkListFromOffset(
  fileSizeBytes: number,
  chunkSizeKB: number,
 resumeOffset: number = 0,
): ChunkMeta[] {
  if (fileSizeBytes <= 0) {
    throw new Error('[FastPix] File size must be greater than 0 bytes.');
  }

  const chunkSizeBytes = chunkSizeKB * 1024;

  if (chunkSizeBytes < MIN_CHUNK_SIZE_KB * 1024) {
    throw new Error(
      `[FastPix] chunkSize must be at least ${MIN_CHUNK_SIZE_KB} KB.`,
    );
  }

  if (resumeOffset < 0 || resumeOffset > fileSizeBytes) {
    throw new Error('[FastPix] Invalid resume offset.');
  }

  const chunks: ChunkMeta[] = [];

  let offset = resumeOffset;
  let index = Math.floor(resumeOffset / chunkSizeBytes);

  while (offset < fileSizeBytes) {
    const nextBoundary =
      Math.floor(offset / chunkSizeBytes) * chunkSizeBytes + chunkSizeBytes;

    const end = Math.min(nextBoundary, fileSizeBytes);

    chunks.push({
      index,
      start: offset,
      end,
      totalSize: fileSizeBytes,
    });

    offset = end;
    index += 1;
  }

  return chunks;
}

export function chunkIndexForOffset(
  resumeOffset: number,
  chunkSizeKB: number,
): number {
  const chunkSizeBytes = chunkSizeKB * 1024;
  const index = Math.floor(resumeOffset / chunkSizeBytes);
  
  log('[FastPix:ChunkEngine] chunkIndexForOffset() calculated', {
    resumeOffset,
    chunkSizeKB,
    chunkSizeBytes,
    calculatedIndex: index,
  });
  
  return index;
}

export function buildContentRangeHeader(chunk: ChunkMeta): string {
  const headerValue = `bytes ${chunk.start}-${chunk.end - 1}/${chunk.totalSize}`;
  
  log('[FastPix:ChunkEngine] buildContentRangeHeader() created', {
    chunkIndex: chunk.index,
    start: chunk.start,
    end: chunk.end - 1,
    total: chunk.totalSize,
    headerValue,
  });
  
  return headerValue;
}
