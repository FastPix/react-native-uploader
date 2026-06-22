import {
  buildChunkListFromOffset,
  chunkIndexForOffset,
  buildContentRangeHeader,
} from '../src/core/ChunkEngine';

describe('ChunkEngine', () => {
  describe('buildChunkListFromOffset', () => {
    it('produces the correct number of chunks for an evenly divisible file', () => {
      // 10 MB file, 5 MB chunks → 2 chunks
      const chunks = buildChunkListFromOffset(10 * 1024 * 1024, 5 * 1024);
      expect(chunks).toHaveLength(2);
    });

    it('produces an extra smaller chunk when the file does not divide evenly', () => {
      // 12 MB file, 5 MB chunks → 3 chunks (5 MB, 5 MB, 2 MB)
      const chunks = buildChunkListFromOffset(12 * 1024 * 1024, 5 * 1024);
      expect(chunks).toHaveLength(3);
      // Last chunk is smaller
      const last = chunks[chunks.length - 1];
      expect(last.end - last.start).toBeLessThan(5 * 1024 * 1024);
    });

    it('assigns zero-based sequential indices', () => {
      const chunks = buildChunkListFromOffset(20 * 1024 * 1024, 5 * 1024);
      chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });

    it('covers the entire file without gaps or overlaps', () => {
      const fileSize = 17 * 1024 * 1024;
      const chunks = buildChunkListFromOffset(fileSize, 5 * 1024);

      // First chunk starts at 0
      expect(chunks[0].start).toBe(0);

      // Each chunk.end equals the next chunk.start
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].start).toBe(chunks[i - 1].end);
      }

      // Last chunk ends exactly at file size
      expect(chunks[chunks.length - 1].end).toBe(fileSize);
    });

    it('correctly sets totalSize on every chunk', () => {
      const fileSize = 8 * 1024 * 1024;
      const chunks = buildChunkListFromOffset(fileSize, 5 * 1024);
      chunks.forEach((chunk) => {
        expect(chunk.totalSize).toBe(fileSize);
      });
    });

    it('handles a file smaller than one chunk', () => {
      // 2 MB file with 5 MB chunk size → 1 chunk
      const fileSize = 2 * 1024 * 1024;
      const chunks = buildChunkListFromOffset(fileSize, 5 * 1024);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].start).toBe(0);
      expect(chunks[0].end).toBe(fileSize);
    });

    it('throws for zero file size', () => {
      expect(() => buildChunkListFromOffset(0, 5 * 1024)).toThrow('[FastPix]');
    });
  });

  describe('chunkIndexForOffset', () => {
    it('returns 0 for a 0 byte offset', () => {
      expect(chunkIndexForOffset(0, 5 * 1024)).toBe(0);
    });

    it('returns the correct index for an exact chunk boundary', () => {
      // 5 MB boundary → chunk index 1
      expect(chunkIndexForOffset(5 * 1024 * 1024, 5 * 1024)).toBe(1);
    });

    it('returns the same index for offsets within the same chunk', () => {
      const chunkSizeKB = 5 * 1024;
      // 1 byte and 5 MB - 1 byte are both in chunk 0
      expect(chunkIndexForOffset(1, chunkSizeKB)).toBe(0);
      expect(chunkIndexForOffset(5 * 1024 * 1024 - 1, chunkSizeKB)).toBe(0);
    });
  });

  describe('buildContentRangeHeader', () => {
    it('produces a valid Content-Range header for the first chunk', () => {
      const chunk = { index: 0, start: 0, end: 5242880, totalSize: 10485760 };
      expect(buildContentRangeHeader(chunk)).toBe(
        'bytes 0-5242879/10485760',
      );
    });

    it('produces a valid Content-Range header for a mid-file chunk', () => {
      const chunk = {
        index: 1,
        start: 5242880,
        end: 10485760,
        totalSize: 15728640,
      };
      expect(buildContentRangeHeader(chunk)).toBe(
        'bytes 5242880-10485759/15728640',
      );
    });
  });
});
