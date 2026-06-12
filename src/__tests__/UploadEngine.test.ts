// /**
//  * UploadEngine unit tests — Phase 2
//  *
//  * react-native-blob-util and axios are mocked so these tests run in Node
//  * without a native environment. We test:
//  *   - Successful single-chunk upload
//  *   - Successful multi-chunk upload with correct progress callbacks
//  *   - Per-chunk exponential back-off retry
//  *   - Max retries exceeded → EngineResult.success = false
//  *   - Abort mid-upload
//  *   - onChunkAttempt / onChunkAttemptFailure callback firing
//  */

// // ── Mocks ─────────────────────────────────────────────────────────────────────

// jest.mock('react-native-blob-util', () => ({
//   __esModule: true,
//   default: {
//     fs: {
//       readStream: jest.fn().mockImplementation(() =>
//         Promise.resolve({
//           open: jest.fn(),
//           onData: jest.fn((cb: (data: string) => void) => {
//             // Immediately emit a small base64 payload and end.
//             cb(Buffer.from('fake-chunk-data').toString('base64'));
//           }),
//           onError: jest.fn(),
//           onEnd: jest.fn((cb: () => void) => cb()),
//         }),
//       ),
//     },
//     base64: {
//       decode: jest.fn((b64: string) => Buffer.from(b64, 'base64').toString('binary')),
//     },
//   },
// }));

// jest.mock('axios', () => {
//   const actual = jest.requireActual('axios') as typeof import('axios');
//   return {
//     ...actual,
//     default: {
//       put: jest.fn(),
//       isCancel: jest.fn(() => false),
//       CancelToken: {
//         source: jest.fn(() => ({
//           token: {},
//           cancel: jest.fn(),
//         })),
//       },
//     },
//     isCancel: jest.fn(() => false),
//   };
// });

// // ── Imports (after mocks) ─────────────────────────────────────────────────────

// import axios from 'axios';
// import { UploadEngine } from '../core/UploadEngine';
// import type { UploadEngineOptions } from '../core/UploadEngine';

// // ── Helpers ───────────────────────────────────────────────────────────────────

// const FILE_SIZE_5MB = 5 * 1024 * 1024;
// const FILE_SIZE_12MB = 12 * 1024 * 1024;
// const CHUNK_SIZE_KB = 5 * 1024; // 5 MB

// function makeOpts(overrides: Partial<UploadEngineOptions> = {}): UploadEngineOptions {
//   return {
//     endpoint: 'https://example.com/upload',
//     fileUri: 'file:///video.mp4',
//     fileSizeBytes: FILE_SIZE_5MB,
//     chunkSizeKB: CHUNK_SIZE_KB,
//     maxRetries: 3,
//     retryDelay: 10, // keep tests fast
//     onChunkAttempt: jest.fn(),
//     onChunkAttemptFailure: jest.fn(),
//     onChunkSuccess: jest.fn(),
//     onProgress: jest.fn(),
//     ...overrides,
//   };
// }

// const mockedAxios = axios as jest.Mocked<typeof axios>;

// beforeEach(() => {
//   jest.clearAllMocks();
// });

// // ── Tests ─────────────────────────────────────────────────────────────────────

// describe('UploadEngine', () => {
//   describe('successful upload', () => {
//     it('returns { success: true } for a single-chunk file', async () => {
//       mockedAxios.put.mockResolvedValueOnce({ status: 200 });

//       const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB });
//       const engine = new UploadEngine(opts);
//       const result = await engine.run();

//       expect(result.success).toBe(true);
//       expect(result.error).toBeUndefined();
//     });

//     it('calls onProgress once per chunk', async () => {
//       mockedAxios.put.mockResolvedValue({ status: 308 }); // intermediate
//       mockedAxios.put
//         .mockResolvedValueOnce({ status: 308 })
//         .mockResolvedValueOnce({ status: 308 })
//         .mockResolvedValueOnce({ status: 200 }); // last chunk

//       const onProgress = jest.fn();
//       const opts = makeOpts({
//         fileSizeBytes: FILE_SIZE_12MB, // 3 × 5 MB chunks (last is 2 MB)
//         onProgress,
//       });
//       const engine = new UploadEngine(opts);
//       await engine.run();

//       // 12 MB file with 5 MB chunks → 3 chunks → 3 progress calls
//       expect(onProgress).toHaveBeenCalledTimes(3);
//     });

//     it('calls onChunkSuccess with correct chunkIndex and offset', async () => {
//       mockedAxios.put.mockResolvedValue({ status: 200 });

//       const onChunkSuccess = jest.fn();
//       const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB, onChunkSuccess });
//       const engine = new UploadEngine(opts);
//       await engine.run();

//       expect(onChunkSuccess).toHaveBeenCalledWith(0, FILE_SIZE_5MB);
//     });

//     it('calls onChunkAttempt before each upload attempt', async () => {
//       mockedAxios.put.mockResolvedValue({ status: 200 });

//       const onChunkAttempt = jest.fn();
//       const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB, onChunkAttempt });
//       const engine = new UploadEngine(opts);
//       await engine.run();

//       expect(onChunkAttempt).toHaveBeenCalledWith(0, 1);
//     });

//     it('starts from the correct chunk when setStartChunkIndex is set', async () => {
//       // 12 MB → 3 chunks. Start from chunk 1 (i.e. resume after first chunk).
//       mockedAxios.put
//         .mockResolvedValueOnce({ status: 308 })
//         .mockResolvedValueOnce({ status: 200 });

//       const onChunkSuccess = jest.fn();
//       const opts = makeOpts({
//         fileSizeBytes: FILE_SIZE_12MB,
//         onChunkSuccess,
//       });
//       const engine = new UploadEngine(opts);
//       engine.setStartChunkIndex(1); // skip chunk 0
//       await engine.run();

//       // Only chunks 1 and 2 should have been uploaded.
//       expect(onChunkSuccess).toHaveBeenCalledTimes(2);
//       expect(onChunkSuccess.mock.calls[0]?.[0]).toBe(1); // first call = chunk index 1
//     });
//   });

//   describe('retry with exponential back-off', () => {
//     it('retries on failure and succeeds within maxRetries', async () => {
//       // Fail twice, then succeed on third attempt.
//       mockedAxios.put
//         .mockRejectedValueOnce(new Error('Network error'))
//         .mockRejectedValueOnce(new Error('Network error'))
//         .mockResolvedValueOnce({ status: 200 });

//       const onChunkAttemptFailure = jest.fn();
//       const opts = makeOpts({
//         fileSizeBytes: FILE_SIZE_5MB,
//         maxRetries: 3,
//         onChunkAttemptFailure,
//       });
//       const engine = new UploadEngine(opts);
//       const result = await engine.run();

//       expect(result.success).toBe(true);
//       // Two failures before success.
//       expect(onChunkAttemptFailure).toHaveBeenCalledTimes(2);
//     });

//     it('returns { success: false } after exhausting all retries', async () => {
//       mockedAxios.put.mockRejectedValue(new Error('Persistent server error'));

//       const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB, maxRetries: 2 });
//       const engine = new UploadEngine(opts);
//       const result = await engine.run();

//       expect(result.success).toBe(false);
//       expect(result.error?.message).toContain('[FastPix]');
//     });

//     it('calls onChunkAttemptFailure with incrementing attempt numbers', async () => {
//       mockedAxios.put
//         .mockRejectedValueOnce(new Error('err'))
//         .mockRejectedValueOnce(new Error('err'))
//         .mockResolvedValueOnce({ status: 200 });

//       const onChunkAttemptFailure = jest.fn();
//       const opts = makeOpts({
//         fileSizeBytes: FILE_SIZE_5MB,
//         maxRetries: 3,
//         onChunkAttemptFailure,
//       });
//       const engine = new UploadEngine(opts);
//       await engine.run();

//       expect(onChunkAttemptFailure).toHaveBeenNthCalledWith(
//         1,
//         0,   // chunkIndex
//         1,   // attemptNumber
//         expect.any(Error),
//       );
//       expect(onChunkAttemptFailure).toHaveBeenNthCalledWith(
//         2,
//         0,
//         2,
//         expect.any(Error),
//       );
//     });
//   });

//   describe('abort', () => {
//     it('returns { success: false } when aborted before upload starts', async () => {
//       // Make axios hang so we can abort before it resolves.
//       mockedAxios.put.mockImplementation(
//         () => new Promise(() => {}), // never resolves
//       );

//       const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB });
//       const engine = new UploadEngine(opts);

//       const runPromise = engine.run();
//       engine.abort();

//       const result = await runPromise;
//       expect(result.success).toBe(false);
//       expect(result.error?.message).toContain('aborted');
//     });
//   });
// });

/**
 * UploadEngine unit tests — Phase 2
 *
 * react-native-blob-util and axios are mocked so these tests run in Node
 * without a native environment. We test:
 *   - Successful single-chunk upload
 *   - Successful multi-chunk upload with correct progress callbacks
 *   - Per-chunk exponential back-off retry
 *   - Max retries exceeded → EngineResult.success = false
 *   - Abort mid-upload
 *   - onChunkAttempt / onChunkAttemptFailure callback firing
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      readStream: jest.fn().mockImplementation(() =>
        Promise.resolve({
          open: jest.fn(),
          onData: jest.fn((cb: (data: string) => void) => {
            // Immediately emit a small base64 payload and end.
            cb(Buffer.from('fake-chunk-data').toString('base64'));
          }),
          onError: jest.fn(),
          onEnd: jest.fn((cb: () => void) => cb()),
        }),
      ),
    },
    base64: {
      decode: jest.fn((b64: string) => Buffer.from(b64, 'base64').toString('binary')),
    },
  },
}));

jest.mock('axios', () => {
  const actual = jest.requireActual('axios') as typeof import('axios');
  const mockPut = jest.fn();
  const mockIsCancel = jest.fn(() => false);
  const mockCancelToken = {
    source: jest.fn(() => ({
      token: {},
      cancel: jest.fn(),
    })),
  };

  return {
    ...actual,
    put: mockPut,
    isCancel: mockIsCancel,
    CancelToken: mockCancelToken,
    default: {
      ...actual.default,
      put: mockPut,
      isCancel: mockIsCancel,
      CancelToken: mockCancelToken,
    },
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import axios from 'axios';
import { UploadEngine } from '../core/UploadEngine';
import type { UploadEngineOptions } from '../core/UploadEngine';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FILE_SIZE_5MB = 5 * 1024 * 1024;
const FILE_SIZE_12MB = 12 * 1024 * 1024;
const CHUNK_SIZE_KB = 5 * 1024; // 5 MB

function makeOpts(overrides: Partial<UploadEngineOptions> = {}): UploadEngineOptions {
  return {
    endpoint: 'https://example.com/upload',
    fileUri: 'file:///video.mp4',
    fileSizeBytes: FILE_SIZE_5MB,
    chunkSizeKB: CHUNK_SIZE_KB,
    maxRetries: 3,
    retryDelay: 1, // minimized down to 1ms to keep tests blistering fast
    onChunkAttempt: jest.fn(),
    onChunkAttemptFailure: jest.fn(),
    onChunkSuccess: jest.fn(),
    onProgress: jest.fn(),
    ...overrides,
  };
}

// const mockedAxios = axios as jest.Mocked<typeof axios>;

// beforeEach(() => {
//   jest.clearAllMocks();
// });

const mockedAxios = axios as jest.Mocked<typeof axios>;

beforeEach(() => {
  jest.clearAllMocks();
  // 🟢 Mute the console warnings so they don't flood your terminal output
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // 🟢 Restore the original console behavior after each test completes
  (console.warn as jest.Mock).mockRestore();
});


// ── Tests ─────────────────────────────────────────────────────────────────────

describe('UploadEngine', () => {
  describe('successful upload', () => {
    it('returns { success: true } for a single-chunk file', async () => {
      mockedAxios.put.mockResolvedValueOnce({ status: 200 });

      const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB });
      const engine = new UploadEngine(opts);
      const result = await engine.run();

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('calls onProgress once per chunk', async () => {
      mockedAxios.put.mockResolvedValue({ status: 308 }); // intermediate
      mockedAxios.put
        .mockResolvedValueOnce({ status: 308 })
        .mockResolvedValueOnce({ status: 308 })
        .mockResolvedValueOnce({ status: 200 }); // last chunk

      const onProgress = jest.fn();
      const opts = makeOpts({
        fileSizeBytes: FILE_SIZE_12MB, // 3 × 5 MB chunks (last is 2 MB)
        onProgress,
      });
      const engine = new UploadEngine(opts);
      await engine.run();

      // 12 MB file with 5 MB chunks → 3 chunks → 3 progress calls
      expect(onProgress).toHaveBeenCalledTimes(3);
    });

    it('calls onChunkSuccess with correct chunkIndex and offset', async () => {
      mockedAxios.put.mockResolvedValue({ status: 200 });

      const onChunkSuccess = jest.fn();
      const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB, onChunkSuccess });
      const engine = new UploadEngine(opts);
      await engine.run();

      expect(onChunkSuccess).toHaveBeenCalledWith(0, FILE_SIZE_5MB);
    });

    it('calls onChunkAttempt before each upload attempt', async () => {
      mockedAxios.put.mockResolvedValue({ status: 200 });

      const onChunkAttempt = jest.fn();
      const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB, onChunkAttempt });
      const engine = new UploadEngine(opts);
      await engine.run();

      expect(onChunkAttempt).toHaveBeenCalledWith(0, 1);
    });

    it('starts from the correct chunk when setStartChunkIndex is set', async () => {
      // 12 MB → 3 chunks. Start from chunk 1 (i.e. resume after first chunk).
      mockedAxios.put
        .mockResolvedValueOnce({ status: 308 })
        .mockResolvedValueOnce({ status: 200 });

      const onChunkSuccess = jest.fn();
      const opts = makeOpts({
        fileSizeBytes: FILE_SIZE_12MB,
        onChunkSuccess,
      });
      const engine = new UploadEngine(opts);
      engine.setStartChunkIndex(1); // skip chunk 0
      await engine.run();

      // Only chunks 1 and 2 should have been uploaded.
      expect(onChunkSuccess).toHaveBeenCalledTimes(2);
      expect(onChunkSuccess.mock.calls[0]?.[0]).toBe(1); // first call = chunk index 1
    });
  });

  describe('retry with exponential back-off', () => {
    it('retries on failure and succeeds within maxRetries', async () => {
      // Fail twice, then succeed on third attempt.
      mockedAxios.put
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ status: 200 });

      const onChunkAttemptFailure = jest.fn();
      const opts = makeOpts({
        fileSizeBytes: FILE_SIZE_5MB,
        maxRetries: 3,
        onChunkAttemptFailure,
      });
      const engine = new UploadEngine(opts);
      const result = await engine.run();

      expect(result.success).toBe(true);
      // Two failures before success.
      expect(onChunkAttemptFailure).toHaveBeenCalledTimes(2);
    });

    it('returns { success: false } after exhausting all retries', async () => {
      mockedAxios.put.mockRejectedValue(new Error('Persistent server error'));

      const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB, maxRetries: 2 });
      const engine = new UploadEngine(opts);
      const result = await engine.run();

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('[FastPix]');
    });

    it('calls onChunkAttemptFailure with incrementing attempt numbers', async () => {
      mockedAxios.put
        .mockRejectedValueOnce(new Error('err'))
        .mockRejectedValueOnce(new Error('err'))
        .mockResolvedValueOnce({ status: 200 });

      const onChunkAttemptFailure = jest.fn();
      const opts = makeOpts({
        fileSizeBytes: FILE_SIZE_5MB,
        maxRetries: 3,
        onChunkAttemptFailure,
      });
      const engine = new UploadEngine(opts);
      await engine.run();

      expect(onChunkAttemptFailure).toHaveBeenNthCalledWith(
        1,
        0,   // chunkIndex
        1,   // attemptNumber
        expect.any(Error),
      );
      expect(onChunkAttemptFailure).toHaveBeenNthCalledWith(
        2,
        0,
        2,
        expect.any(Error),
      );
    });
  });

  // describe('abort', () => {
  //   it('returns { success: false } when aborted before upload starts', async () => {
  //     // Make axios hang so we can abort before it resolves.
  //     mockedAxios.put.mockImplementation(
  //       () => new Promise(() => {}), // never resolves
  //     );

  //     const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB });
  //     const engine = new UploadEngine(opts);

  //     const runPromise = engine.run();
  //     engine.abort();

  //     await flushAsync(); 

  //     const result = await runPromise;
  //     expect(result.success).toBe(false);
  //     expect(result.error?.message).toContain('aborted');
  //   });
  // });
    describe('abort', () => {
    it('returns { success: false } when aborted before upload starts', async () => {
      // 1. Setup the mock to remain pending
      mockedAxios.put.mockImplementation(() => new Promise(() => {}));

      const opts = makeOpts({ fileSizeBytes: FILE_SIZE_5MB });
      const engine = new UploadEngine(opts);

      // 2. Run the engine, trigger the abort flag immediately, and flush the microtasks
      const runPromise = engine.run();
      engine.abort();

      const result = await runPromise;
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('aborted');
    });
  });

});

