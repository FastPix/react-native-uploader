import type { ChunkMeta } from '../types';
export declare function buildChunkList(fileSizeBytes: number, chunkSizeKB: number): ChunkMeta[];
export declare function chunkIndexForOffset(resumeOffset: number, chunkSizeKB: number): number;
export declare function buildContentRangeHeader(chunk: ChunkMeta): string;
//# sourceMappingURL=ChunkEngine.d.ts.map