import { UploadEngine } from '../src/core/UploadEngine';
import type { UploadEngineOptions } from '../src/core/UploadEngine';

// ── Mock logger ───────────────────────────────────────────────────────────────
jest.mock('../utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

// ── Mock ChunkEngine ──────────────────────────────────────────────────────────
jest.mock('./ChunkEngine', () => ({
  buildChunkListFromOffset: jest.fn(),
  buildContentRangeHeader: jest.fn(
    (chunk: { start: number; end: number; totalSize: number }) =>
      `bytes ${chunk.start}-${chunk.end - 1}/${chunk.totalSize}`,
  ),
}));

import { buildChunkListFromOffset } from '../src/core/ChunkEngine';

// ── Mock react-native-blob-util ───────────────────────────────────────────────
const mockSlice = jest.fn();
const mockLs = jest.fn();
const mockUnlink = jest.fn();
const mockExists = jest.fn();
const mockDf = jest.fn();
const mockCancel = jest.fn();

// Holds the uploadProgress callback registered by the engine
let uploadProgressCallback: ((written: number, _total: number) => void) | null = null;

interface MockRequest {
  uploadProgress: jest.Mock;
  cancel: jest.Mock;
  then: jest.Mock;
}

const mockFetch = jest.fn().mockImplementation(() => {
  const request: MockRequest = {
    uploadProgress: jest.fn((_opts: unknown, cb: (w: number, t: number) => void) => {
      uploadProgressCallback = cb;
      return request; // chainable
    }),
    cancel: mockCancel,
    then: jest.fn(),
  };

  // Make `await request` resolve with a 200-range response by default
  return Object.assign(
    Promise.resolve({ respInfo: { status: 200 } }),
    request,
  );
});

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { CacheDir: '/cache' },
      stat: jest.fn(),
      slice: mockSlice,
      ls: mockLs,
      unlink: mockUnlink,
      exists: mockExists,
      df: mockDf,
    },
    fetch: mockFetch,
    wrap: jest.fn((p: string) => p),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const CHUNK_5MB = 5 * 1024; // KB
const ONE_MB = 1024 * 1024;

function makeChunk(index: number, start: number, end: number, totalSize: number) {
  return { index, start, end, totalSize };
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

  beforeEach(() => {
    jest.clearAllMocks();
    uploadProgressCallback = null;

    // Default: plenty of disk space
    mockDf.mockResolvedValue({ free: 500 * ONE_MB });
    // Default: no stale files
    mockLs.mockResolvedValue([]);
    // Default: slice succeeds
    mockSlice.mockResolvedValue(undefined);
    // Default: temp file cleanup
    mockExists.mockResolvedValue(true);
    mockUnlink.mockResolvedValue(undefined);

    opts = buildDefaultOpts();
    engine = new UploadEngine(opts);
  });

  // ── setStartOffset / abort ────────────────
  describe('setStartOffset()', () => {
    it('clamps negative offsets to 0', () => {
      // No public getter, but run() should use 0 if set to negative
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
      mockDf.mockResolvedValue({ free: 1024 }); // 1 KB — way too little
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      const result = await engine.run();
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Not enough storage/);
    });

    it('proceeds when free space is sufficient', async () => {
      mockDf.mockResolvedValue({ free: 500 * ONE_MB });
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]); // 0 chunks = instant success

      const result = await engine.run();
      expect(result.success).toBe(true);
    });

    it('proceeds when df() fails (fails open)', async () => {
      mockDf.mockRejectedValue(new Error('df failed'));
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      const result = await engine.run();
      expect(result.success).toBe(true);
    });

    it('uses internal_free when free is not a number', async () => {
      mockDf.mockResolvedValue({ internal_free: 500 * ONE_MB });
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      const result = await engine.run();
      expect(result.success).toBe(true);
    });
  });

  // ── stale temp file cleanup ───────────────
  describe('stale temp file cleanup', () => {
    it('deletes files prefixed with "fastpix_chunk_"', async () => {
      mockLs.mockResolvedValue(['fastpix_chunk_123_456', 'other_file.tmp']);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      await engine.run();

      expect(mockUnlink).toHaveBeenCalledWith('/cache/fastpix_chunk_123_456');
      expect(mockUnlink).not.toHaveBeenCalledWith(expect.stringContaining('other_file'));
    });

    it('skips cleanup when ls returns no stale files', async () => {
      mockLs.mockResolvedValue(['other_file.tmp']);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([]);

      await engine.run();
      expect(mockUnlink).not.toHaveBeenCalled();
    });
  });

  // ── successful single-chunk upload ────────
  describe('single chunk — success', () => {
    it('returns { success: true } when chunk uploads with HTTP 200', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 200 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

      const result = await engine.run();
      expect(result.success).toBe(true);
    });

    it('calls onChunkAttempt once per chunk', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 200 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

      await engine.run();
      expect(opts.onChunkAttempt).toHaveBeenCalledTimes(1);
      expect(opts.onChunkAttempt).toHaveBeenCalledWith(0, 1, 1);
    });

    it('calls onChunkSuccess with correct offset', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 200 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

      await engine.run();
      expect(opts.onChunkSuccess).toHaveBeenCalledWith(0, ONE_MB * 5);
    });

    it('treats HTTP 308 as success', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);
      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 308 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

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
      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 200 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

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
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Object.assign(Promise.reject(new Error('Network error')), {
            uploadProgress: jest.fn().mockReturnThis(),
            cancel: mockCancel,
          });
        }
        return Object.assign(Promise.resolve({ respInfo: { status: 200 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        });
      });

      const result = await engine.run();
      expect(result.success).toBe(true);
      expect(opts.onChunkAttemptFailure).toHaveBeenCalledTimes(1);
    });

    it('returns failure after exhausting all retries', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      mockFetch.mockReturnValue(
        Object.assign(Promise.reject(new Error('Persistent error')), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
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

      mockFetch.mockReturnValue(
        Object.assign(Promise.reject(new Error('fail')), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

      await engine.run();
      // 2 retries → onChunkAttemptFailure called for each failed attempt (1 initial + 2 retries = 3 attempts, 2 failures before final)
      expect(opts.onChunkAttemptFailure).toHaveBeenCalledTimes(2);
    });
  });

  // ── HTTP error status ─────────────────────
  describe('HTTP error status codes', () => {
    it('treats HTTP 400 as a failure', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 400 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

      const result = await engine.run();
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/HTTP 400/);
    });

    it('treats HTTP 500 as a failure', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 500 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

      const result = await engine.run();
      expect(result.success).toBe(false);
    });
  });

  // ── abort mid-upload ──────────────────────
  describe('abort during upload', () => {
    it('returns { success: false } with aborted message when aborted before first chunk', async () => {
      const chunk = makeChunk(0, 0, ONE_MB * 5, ONE_MB * 5);
      (buildChunkListFromOffset as jest.Mock).mockReturnValue([chunk]);

      mockSlice.mockImplementation(async () => {
        engine.abort();
      });

      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 200 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

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
      mockExists.mockResolvedValue(true);

      mockFetch.mockReturnValue(
        Object.assign(Promise.resolve({ respInfo: { status: 200 } }), {
          uploadProgress: jest.fn().mockReturnThis(),
          cancel: mockCancel,
        }),
      );

      await engine.run();
      // Give microtasks a chance to run the finally cleanup
      await new Promise((r) => setTimeout(r, 0));
      expect(mockUnlink).toHaveBeenCalled();
    });
  });
});