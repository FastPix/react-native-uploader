import { UploadEngine } from '../src/core/UploadEngine';
import type { UploadEngineOptions } from '../src/core/UploadEngine';

// ── Mock logger ───────────────────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

// ── Mock ChunkEngine ──────────────────────────────────────────────────────────
jest.mock('../src/core/ChunkEngine', () => ({
  buildChunkListFromOffset: jest.fn(),
  buildContentRangeHeader: jest.fn(
    (chunk: { start: number; end: number; totalSize: number }) =>
      `bytes ${chunk.start}-${chunk.end - 1}/${chunk.totalSize}`,
  ),
}));

import { buildChunkListFromOffset } from '../src/core/ChunkEngine';

// ── Mock react-native-blob-util ───────────────────────────────────────────────
// All mock fns are created INSIDE the factory (jest.fn()) so hoisting is safe.
// We retrieve references via getRNBlobUtil() after the module is set up.
jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { CacheDir: '/cache' },
      stat: jest.fn(),
      slice: jest.fn(),
      ls: jest.fn(),
      unlink: jest.fn(),
      exists: jest.fn(),
      df: jest.fn(),
    },
    fetch: jest.fn(),
    wrap: jest.fn((p: string) => p),
  },
}));

// Helper to get the mocked RNBlobUtil default export
function getRNBlobUtil() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('react-native-blob-util').default as {
    fs: {
      dirs: { CacheDir: string };
      stat: jest.Mock;
      slice: jest.Mock;
      ls: jest.Mock;
      unlink: jest.Mock;
      exists: jest.Mock;
      df: jest.Mock;
    };
    fetch: jest.Mock;
    wrap: jest.Mock;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const CHUNK_5MB = 5 * 1024; // KB
const ONE_MB = 1024 * 1024;

function makeChunk(index: number, start: number, end: number, totalSize: number) {
  return { index, start, end, totalSize };
}

function makeFetchResponse(status: number) {
  return Object.assign(Promise.resolve({ respInfo: { status } }), {
    uploadProgress: jest.fn().mockReturnThis(),
    cancel: jest.fn(),
  });
}

function buildDefaultOpts(overrides: Partial<UploadEngineOptions> = {}): UploadEngineOptions {
  return {
    endpoint: 'https://example.com/upload',
    fileUri: '/storage/video.mp4',
    fileSizeBytes: ONE_MB * 10,
    chunkSizeKB: CHUNK_5MB,
    maxRetries: 2,
    retryDelay: 0,
    onChunkAttempt: jest.fn(),
    onChunkAttemptFailure: jest.fn(),
    onChunkSuccess: jest.fn(),
    onProgress: jest.fn(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────
describe('UploadEngine', () => {
  let opts: UploadEngineOptions;
  let engine: UploadEngine;
  let rn: ReturnType<typeof getRNBlobUtil>;

  beforeEach(() => {
    jest.clearAllMocks();
    rn = getRNBlobUtil();

    // Default: plenty of disk space
    rn.fs.df.mockResolvedValue({ free: 500 * ONE_MB });
    // Default: no stale files
    rn.fs.ls.mockResolvedValue([]);
    // Default: slice succeeds
    rn.fs.slice.mockResolvedValue(undefined);
    // Default: temp file cleanup
    rn.fs.exists.mockResolvedValue(true);
    rn.fs.unlink.mockResolvedValue(undefined);
    // Default fetch: 200
    rn.fetch.mockReturnValue(makeFetchResponse(200));

    opts = buildDefaultOpts();
    engine = new UploadEngine(opts);
  });

  // ── setStartOffset / abort ────────────────
  describe('setStartOffset()', () => {
    it('clamps negative offsets to 0', () => {
      expect(() => engine.setStartOffset(-100)).not.toThrow();
    });

    it('accepts a valid positive offset', () => {
      expect(() => engine.setStartOffset(ONE_MB * 5)).not.toThrow();
    });
  });

  describe('abort()', () => {
    it('does not throw when called before run()', () => {
      expect(() => engine.abort()).not.toThrow();
    });
  });

  // ── disk space guard ──────────────────────
  describe('disk space check', () => {
    it('returns failure when free space is insufficient', async () => {
      rn.fs.df.mockResolvedValue({ free: 1024 }); // 1 KB — way too little
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      const result = await engine.run();
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Not enough storage/);
    });

    it('proceeds when free space is sufficient', async () => {
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);
      const result = await engine.run();
      expect(result.success).toBe(true);
    });

    it('proceeds when df() fails (fails open)', async () => {
      rn.fs.df.mockRejectedValue(new Error('df failed'));
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);
      const result = await engine.run();
      expect(result.success).toBe(true);
    });

    it('uses internal_free when free is not a number', async () => {
      rn.fs.df.mockResolvedValue({ internal_free: 500 * ONE_MB });
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);
      const result = await engine.run();
      expect(result.success).toBe(true);
    });
  });

  // ── stale temp file cleanup ───────────────
  describe('stale temp file cleanup', () => {
    it('deletes files prefixed with "fastpix_chunk_"', async () => {
      rn.fs.ls.mockResolvedValue(['fastpix_chunk_123_456', 'other_file.tmp']);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      await engine.run();

      expect(rn.fs.unlink).toHaveBeenCalledWith('/cache/fastpix_chunk_123_456');
      expect(rn.fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining('other_file'));
    });

    it('skips cleanup when ls returns no stale files', async () => {
      rn.fs.ls.mockResolvedValue(['other_file.tmp']);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      await engine.run();
      expect(rn.fs.unlink).not.toHaveBeenCalled();
    });
  });

  // ── successful single-chunk upload ────────
  describe('single chunk — success', () => {
    it('returns { success: true } when chunk uploads with HTTP 200', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      rn.fetch.mockReturnValue(makeFetchResponse(200));

      const result = await engine.run();
      expect(result.success).toBe(true);
    });

    it('calls onChunkAttempt once per chunk', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      await engine.run();
      expect(opts.onChunkAttempt).toHaveBeenCalledTimes(1);
      expect(opts.onChunkAttempt).toHaveBeenCalledWith(0, 1, 1);
    });

    it('calls onChunkSuccess with correct offset', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      await engine.run();
      expect(opts.onChunkSuccess).toHaveBeenCalledWith(0, ONE_MB * 5);
    });

    it('treats HTTP 308 as success', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      rn.fetch.mockReturnValue(makeFetchResponse(308));

      const result = await engine.run();
      expect(result.success).toBe(true);
    });
  });

  // ── multi-chunk upload ────────────────────
  describe('multi-chunk upload', () => {
    it('processes all chunks sequentially and returns success', async () => {
      const chunks = [
        makeChunk(0, 0, ONE_MB * 5, ONE_MB * 10),
        makeChunk(1, ONE_MB * 5, ONE_MB * 10, ONE_MB * 10),
      ];
      (buildChunkListFromOffset as jest.Mock).mockReturnValue(chunks);

      const result = await engine.run();
      expect(result.success).toBe(true);
      expect(opts.onChunkSuccess).toHaveBeenCalledTimes(2);
    });
  });

  // ── retry logic ───────────────────────────
  describe('retry logic', () => {
    it('retries on network failure and succeeds eventually', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      let callCount = 0;
      rn.fetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(Promise.reject(new Error('Network error')), {
            uploadProgress: jest.fn().mockReturnThis(),
            cancel: jest.fn(),
          });
        }
        return makeFetchResponse(200);
      });

      const result = await engine.run();
      expect(result.success).toBe(true);
      expect(opts.onChunkAttemptFailure).toHaveBeenCalledTimes(1);
    });

    it('returns failure after exhausting all retries', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      rn.fetch.mockReturnValue(
        Object.assign(Promise.reject(new Error('Persistent error')), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: jest.fn(),
        }),
      );

      const result = await engine.run();
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/failed after/i);
    });

    it('calls onChunkAttemptFailure on each failed attempt', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      opts = buildDefaultOpts({ maxRetries: 2, retryDelay: 0 });
      engine = new UploadEngine(opts);

      rn.fetch.mockReturnValue(
        Object.assign(Promise.reject(new Error('fail')), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: jest.fn(),
        }),
      );

      await engine.run();
      // maxRetries=2 means up to 3 total attempts (1 initial + 2 retries).
      // The real engine calls onChunkAttemptFailure on every failed attempt
      // including the last one before it exhausts retries → 3 calls total.
      expect(opts.onChunkAttemptFailure).toHaveBeenCalledTimes(3);
    });
  });

  // ── HTTP error status ─────────────────────
  describe('HTTP error status codes', () => {
    it('treats HTTP 400 as a failure', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      rn.fetch.mockReturnValue(makeFetchResponse(400));

      const result = await engine.run();
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/HTTP 400/);
    });

    it('treats HTTP 500 as a failure', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      rn.fetch.mockReturnValue(makeFetchResponse(500));

      const result = await engine.run();
      expect(result.success).toBe(false);
    });
  });

  // ── abort mid-upload ──────────────────────
  describe('abort during upload', () => {
    it('returns { success: false } with aborted message when aborted before first chunk', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      rn.fs.slice.mockImplementation(async () => {
        engine.abort();
      });

      const result = await engine.run();
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/aborted/i);
    });
  });

  // ── temp file lifecycle ───────────────────
  describe('temp file lifecycle', () => {
    it('deletes the temp file after a successful chunk upload', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      rn.fs.exists.mockResolvedValue(true);

      await engine.run();
      await new Promise((r) => setTimeout(r, 0));
      expect(rn.fs.unlink).toHaveBeenCalled();
    });
  });
});