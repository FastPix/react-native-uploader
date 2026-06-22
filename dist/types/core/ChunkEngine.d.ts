import type { ChunkMeta } from '../types';
export declare function buildChunkListFromOffset(fileSizeBytes: number, chunkSizeKB: number, resumeOffset?: number): ChunkMeta[];
export declare function chunkIndexForOffset(resumeOffset: number, chunkSizeKB: number): number;
export declare function buildContentRangeHeader(chunk: ChunkMeta): string;
//# sourceMappingURL=ChunkEngine.d.ts.map