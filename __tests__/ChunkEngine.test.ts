import {
  buildChunkListFromOffset,
  chunkIndexForOffset,
  buildContentRangeHeader,
} from '../src/core/ChunkEngine';
import type { ChunkMeta } from '../src/types';

// Mock logger to suppress output during tests
jest.mock('../src/utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

// MIN_CHUNK_SIZE_KB = 5 * 1024 = 5120 KB
const MIN_CHUNK_KB = 5120;
const ONE_MB = 1024 * 1024;
const CHUNK_5MB = MIN_CHUNK_KB; // 5120 KB

describe('buildChunkListFromOffset()', () => {
  describe('input validation', () => {
    it('throws when fileSizeBytes is 0', () => {
      expect(() => buildChunkListFromOffset(0, CHUNK_5MB)).toThrow(
        '[FastPix] File size must be greater than 0 bytes.',
      );
    });

    it('throws when fileSizeBytes is negative', () => {
      expect(() => buildChunkListFromOffset(-1, CHUNK_5MB)).toThrow(
        '[FastPix] File size must be greater than 0 bytes.',
      );
    });

    it('throws when chunkSizeKB is below minimum (< 5120 KB)', () => {
      expect(() => buildChunkListFromOffset(ONE_MB * 10, 1024)).toThrow(
        `[FastPix] chunkSize must be at least ${MIN_CHUNK_KB} KB.`,
      );
    });

    it('throws when resumeOffset is negative', () => {
      expect(() => buildChunkListFromOffset(ONE_MB * 10, CHUNK_5MB, -1)).toThrow(
        '[FastPix] Invalid resume offset.',
      );
    });

    it('throws when resumeOffset exceeds fileSizeBytes', () => {
      expect(() =>
        buildChunkListFromOffset(ONE_MB * 10, CHUNK_5MB, ONE_MB * 11),
      ).toThrow('[FastPix] Invalid resume offset.');
    });
  });

  describe('chunk generation — no resume offset', () => {
    it('returns one chunk when file fits exactly in one chunk', () => {
      const fileSize = CHUNK_5MB * 1024; // exactly 5 MB
      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject<ChunkMeta>({
        index: 0,
        start: 0,
        end: fileSize,
        totalSize: fileSize,
      });
    });

    it('returns multiple chunks for a file larger than one chunk', () => {
      const chunkBytes = CHUNK_5MB * 1024;
      const fileSize = chunkBytes * 3; // exactly 3 chunks
      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB);

      expect(chunks).toHaveLength(3);
      chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
        expect(chunk.start).toBe(i * chunkBytes);
        expect(chunk.end).toBe((i + 1) * chunkBytes);
        expect(chunk.totalSize).toBe(fileSize);
      });
    });

    it('last chunk is smaller when file size is not a multiple of chunk size', () => {
      const chunkBytes = CHUNK_5MB * 1024;
      const fileSize = chunkBytes * 2 + 1234; // 2 full chunks + remainder
      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB);

      expect(chunks).toHaveLength(3);
      const last = chunks[2]!;
      expect(last.start).toBe(chunkBytes * 2);
      expect(last.end).toBe(fileSize);
    });

    it('chunks are contiguous — no gaps and no overlaps', () => {
      const chunkBytes = CHUNK_5MB * 1024;
      const fileSize = chunkBytes * 4 + 500;
      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB);

      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
      }
      expect(chunks[0]!.start).toBe(0);
      expect(chunks[chunks.length - 1]!.end).toBe(fileSize);
    });

    it('every chunk carries the correct totalSize', () => {
      const fileSize = CHUNK_5MB * 1024 * 7;
      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB);
      chunks.forEach((c) => expect(c.totalSize).toBe(fileSize));
    });
  });

  describe('chunk generation — with resume offset', () => {
    it('returns empty array when resumeOffset equals fileSizeBytes', () => {
      const fileSize = CHUNK_5MB * 1024;
      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB, fileSize);
      expect(chunks).toHaveLength(0);
    });

    it('starts from the correct chunk when resumeOffset is on a boundary', () => {
      const chunkBytes = CHUNK_5MB * 1024;
      const fileSize = chunkBytes * 3;
      const resumeOffset = chunkBytes; // start of chunk 1

      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB, resumeOffset);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.index).toBe(1);
      expect(chunks[0]!.start).toBe(chunkBytes);
    });

    it('starts from the middle of a chunk when resumeOffset is mid-chunk', () => {
      const chunkBytes = CHUNK_5MB * 1024;
      const fileSize = chunkBytes * 3;
      const resumeOffset = chunkBytes + 1000; // mid-way through chunk 1

      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB, resumeOffset);

      // First returned chunk starts at the resumeOffset, not the chunk boundary
      expect(chunks[0]!.start).toBe(resumeOffset);
    });

    it('returns correct number of remaining chunks after partial upload', () => {
      const chunkBytes = CHUNK_5MB * 1024;
      const fileSize = chunkBytes * 5;
      const resumeOffset = chunkBytes * 2; // 2 chunks already done

      const chunks = buildChunkListFromOffset(fileSize, CHUNK_5MB, resumeOffset);
      expect(chunks).toHaveLength(3);
    });

    it('accepts resumeOffset of 0 (equivalent to no resume)', () => {
      const fileSize = CHUNK_5MB * 1024 * 2;
      const chunksNoResume = buildChunkListFromOffset(fileSize, CHUNK_5MB);
      const chunksZeroResume = buildChunkListFromOffset(fileSize, CHUNK_5MB, 0);
      expect(chunksZeroResume).toEqual(chunksNoResume);
    });
  });
});

describe('chunkIndexForOffset()', () => {
  const chunkSizeKB = CHUNK_5MB; // 5 MB chunks
  const chunkBytes = chunkSizeKB * 1024;

  it('returns 0 for offset 0', () => {
    expect(chunkIndexForOffset(0, chunkSizeKB)).toBe(0);
  });

  it('returns 0 for an offset within the first chunk', () => {
    expect(chunkIndexForOffset(chunkBytes - 1, chunkSizeKB)).toBe(0);
  });

  it('returns 1 for an offset exactly at the second chunk boundary', () => {
    expect(chunkIndexForOffset(chunkBytes, chunkSizeKB)).toBe(1);
  });

  it('returns 2 for an offset inside the third chunk', () => {
    expect(chunkIndexForOffset(chunkBytes * 2 + 100, chunkSizeKB)).toBe(2);
  });

  it('returns the correct index for large offsets', () => {
    const offset = chunkBytes * 99;
    expect(chunkIndexForOffset(offset, chunkSizeKB)).toBe(99);
  });
});

describe('buildContentRangeHeader()', () => {
  const makeChunk = (start: number, end: number, totalSize: number, index = 0): ChunkMeta => ({
    index,
    start,
    end,
    totalSize,
  });

  it('builds a correct Content-Range header for the first chunk', () => {
    const chunk = makeChunk(0, 5 * ONE_MB, 20 * ONE_MB, 0);
    expect(buildContentRangeHeader(chunk)).toBe(
      `bytes 0-${5 * ONE_MB - 1}/${20 * ONE_MB}`,
    );
  });

  it('builds a correct Content-Range header for a mid-file chunk', () => {
    const chunk = makeChunk(5 * ONE_MB, 10 * ONE_MB, 20 * ONE_MB, 1);
    expect(buildContentRangeHeader(chunk)).toBe(
      `bytes ${5 * ONE_MB}-${10 * ONE_MB - 1}/${20 * ONE_MB}`,
    );
  });

  it('builds a correct Content-Range header for the last (partial) chunk', () => {
    const totalSize = 22 * ONE_MB;
    const start = 20 * ONE_MB;
    const end = totalSize; // 2 MB remainder
    const chunk = makeChunk(start, end, totalSize, 4);
    expect(buildContentRangeHeader(chunk)).toBe(
      `bytes ${start}-${end - 1}/${totalSize}`,
    );
  });

  it('produces end byte = start when chunk size is 1 byte', () => {
    const chunk = makeChunk(100, 101, 500, 0);
    expect(buildContentRangeHeader(chunk)).toBe('bytes 100-100/500');
  });

  it('uses chunk.end - 1 as the inclusive upper bound (HTTP spec)', () => {
    const chunk = makeChunk(0, 1000, 1000, 0);
    const header = buildContentRangeHeader(chunk);
    expect(header).toMatch(/bytes 0-999\/1000/);
  });
});