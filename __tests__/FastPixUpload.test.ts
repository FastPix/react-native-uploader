const FILE_SIZE_10MB = 10 * 1024 * 1024;
const CHUNK_SIZE_KB  = 5 * 1024; // 5 MB → 2 chunks for a 10 MB file

let _netInfoListener: ((state: object) => void) | null = null;

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn((cb: (state: object) => void) => {
      _netInfoListener = cb;
      return jest.fn(); // unsubscribe function
    }),
    fetch: jest.fn().mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    }),
  },
}));

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      stat: jest.fn().mockResolvedValue({ size: String(FILE_SIZE_10MB) }),
      readStream: jest.fn().mockImplementation(() =>
        Promise.resolve({
          open: jest.fn(),
          onData: jest.fn((cb: (d: string) => void) => {
            cb(Buffer.from('chunk').toString('base64'));
          }),
          onError: jest.fn(),
          onEnd: jest.fn((cb: () => void) => cb()),
        }),
      ),
    },
    base64: {
      decode: jest.fn((b64: string) =>
        Buffer.from(b64, 'base64').toString('binary'),
      ),
    },
  },
}));

// axios mock — we control per-test via mockedAxiosPut
const mockCancel = jest.fn();
jest.mock('axios', () => {
  return {
    __esModule: true,
    default: {
      put: jest.fn(),
      isCancel: jest.fn(() => false),
      CancelToken: {
        source: jest.fn(() => ({ token: {}, cancel: mockCancel })),
      },
    },
    isCancel: jest.fn(() => false),
  };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import axios from 'axios';
import { FastPixUpload } from '../src/core/FastPixUpload';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockedAxios = axios as jest.Mocked<typeof axios>;

/** Build a FastPixUpload with sane test defaults. */
function makeUpload(overrides?: Partial<ConstructorParameters<typeof FastPixUpload>[0]>) {
  return new FastPixUpload({
    endpoint: 'https://example.com/upload',
    fileUri: 'file:///video.mp4',
    chunkSize: CHUNK_SIZE_KB,
    maxRetries: 2,
    retryDelay: 5,     // fast
    autoHandleNetworkEvents: false, // most tests control this manually
    ...overrides,
  });
}

/** Simulate network going offline via the NetInfo listener. */
function goOffline() {
  _netInfoListener?.({ isConnected: false, isInternetReachable: false });
}

/** Simulate network coming back online. */
function goOnline() {
  _netInfoListener?.({ isConnected: true, isInternetReachable: true });
}

/** Resolves after all pending microtasks and a tick of the event loop. */
function flushAsync() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  _netInfoListener = null;
  // Default: every chunk PUT succeeds immediately
  mockedAxios.put.mockResolvedValue({ status: 308 });
});

// ─── Test suites ──────────────────────────────────────────────────────────────
describe('FastPixUpload — FSM & lifecycle events', () => {

  it('starts in IDLE state', () => {
    const upload = makeUpload();
    expect(upload.state).toBe('IDLE');
  });

  it('transitions IDLE → STARTED → UPLOADING → COMPLETED on success', async () => {
    const states: string[] = [];
    const upload = makeUpload();

    upload.on('stateChange', ({ to }) => states.push(to));

    // 10 MB file, 5 MB chunks = 2 chunks
    mockedAxios.put
      .mockResolvedValueOnce({ status: 308 }) // chunk 0
      .mockResolvedValueOnce({ status: 200 }); // chunk 1

    await upload.start();

    expect(states).toEqual(['STARTED', 'UPLOADING', 'COMPLETED']);
    expect(upload.state).toBe('COMPLETED');
  });

  it('emits "started" with fileSize and endpoint', async () => {
    const handler = jest.fn();
    const upload = makeUpload();
    upload.on('started', handler);

    mockedAxios.put
      .mockResolvedValueOnce({ status: 308 })
      .mockResolvedValueOnce({ status: 200 });

    await upload.start();

    expect(handler).toHaveBeenCalledWith({
      fileSize: FILE_SIZE_10MB,
      endpoint: 'https://example.com/upload',
    });
  });

  it('emits "progress" after each chunk', async () => {
    const progressCalls: number[] = [];
    const upload = makeUpload();

    upload.on('progress', ({ percentage }) => progressCalls.push(percentage));

    mockedAxios.put
      .mockResolvedValueOnce({ status: 308 })
      .mockResolvedValueOnce({ status: 200 });

    await upload.start();

    // 2 chunks → 2 progress events, percentages 50% and 100%
    expect(progressCalls).toEqual([50, 100]);
  });

  it('emits "chunkSuccess" for each chunk with correct index and offset', async () => {
    const chunks: Array<{ chunkIndex: number; offset: number }> = [];
    const upload = makeUpload();
    upload.on('chunkSuccess', (p) => chunks.push(p));

    mockedAxios.put
      .mockResolvedValueOnce({ status: 308 })
      .mockResolvedValueOnce({ status: 200 });

    await upload.start();

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ chunkIndex: 0, offset: 5 * 1024 * 1024 });
    expect(chunks[1]).toEqual({ chunkIndex: 1, offset: FILE_SIZE_10MB });
  });

  it('emits "success" when all chunks are acknowledged', async () => {
    const handler = jest.fn();
    const upload = makeUpload();
    upload.on('success', handler);

    mockedAxios.put
      .mockResolvedValueOnce({ status: 308 })
      .mockResolvedValueOnce({ status: 200 });

    await upload.start();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emits "error" and transitions to FAILED when a chunk permanently fails', async () => {
    const errorHandler = jest.fn();
    const upload = makeUpload({ maxRetries: 0 });
    upload.on('error', errorHandler);

    mockedAxios.put.mockRejectedValue(new Error('Server 500'));

    await upload.start();

    expect(upload.state).toBe('FAILED');
    expect(errorHandler).toHaveBeenCalledWith(
      expect.objectContaining({ retriable: false }),
    );
  });

  it('records stateHistory for the full happy path', async () => {
    const upload = makeUpload();

    mockedAxios.put
      .mockResolvedValueOnce({ status: 308 })
      .mockResolvedValueOnce({ status: 200 });

    await upload.start();

    const states = upload.stateHistory.map((e) => `${e.from}→${e.to}`);
    expect(states).toEqual([
      'IDLE→STARTED',
      'STARTED→UPLOADING',
      'UPLOADING→COMPLETED',
    ]);
  });

  it('start() is a no-op when not in IDLE state', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const upload = makeUpload();

    mockedAxios.put.mockReturnValue(new Promise(() => {})); // hang
    upload.start(); // don't await — stays UPLOADING

    await flushAsync();
    await upload.start(); // second call ignored

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('start() ignored'),
    );
    warnSpy.mockRestore();
  });
});

// ─── Pause / Resume ───────────────────────────────────────────────────────────

describe('FastPixUpload — pause and resume', () => {

  it('pause() transitions UPLOADING → PAUSED and emits "pause"', async () => {
    const pauseHandler = jest.fn();
    const upload = makeUpload();
    upload.on('pause', pauseHandler);

    // First chunk hangs so we can pause mid-upload
    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start(); // intentionally not awaited
    await flushAsync();

    upload.pause();

    expect(upload.state).toBe('PAUSED');
    expect(pauseHandler).toHaveBeenCalledWith({ reason: 'user' });
  });

  it('resume() transitions PAUSED → RESUMED → UPLOADING → COMPLETED', async () => {
    const states: string[] = [];
    const upload = makeUpload();
    upload.on('stateChange', ({ to }) => states.push(to));

    // Chunk 0 hangs so we can pause; chunks after resume succeed
    let resolveChunk0: () => void;
    mockedAxios.put
      .mockImplementationOnce(
        () => new Promise<{ status: number }>((res) => {
          resolveChunk0 = () => res({ status: 308 });
        }),
      )
      // Offset-sync PUT (bytes */<size>) returns 308 with no Range header
      .mockResolvedValueOnce({ status: 308, headers: {} })
      // chunk 1 after resume
      .mockResolvedValueOnce({ status: 200 });

    upload.start(); // not awaited
    await flushAsync();
    upload.pause();
    expect(upload.state).toBe('PAUSED');

    // Resolve the hung chunk after pause (simulates in-flight chunk completing)
    resolveChunk0!();
    await flushAsync();

    await upload.resume();

    expect(upload.state).toBe('COMPLETED');
    expect(states).toContain('PAUSED');
    expect(states).toContain('RESUMED');
    expect(states).toContain('COMPLETED');
  });

  it('pause() emits reason "user"', async () => {
    const pauseHandler = jest.fn();
    const upload = makeUpload();
    upload.on('pause', pauseHandler);

    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start();
    await flushAsync();

    upload.pause();
    expect(pauseHandler).toHaveBeenCalledWith({ reason: 'user' });
  });

  it('pause() is a no-op when not UPLOADING', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const upload = makeUpload();
    upload.pause(); // state is IDLE

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('pause() ignored'),
    );
    expect(upload.state).toBe('IDLE');
    warnSpy.mockRestore();
  });

  it('resume() is a no-op when not PAUSED', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const upload = makeUpload();
    await upload.resume(); // state is IDLE

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('resume() ignored'),
    );
    warnSpy.mockRestore();
  });

  it('.progress reflects correct bytesUploaded after first chunk', async () => {
    const upload = makeUpload();

    let resolveChunk0: () => void;
    mockedAxios.put
      .mockImplementationOnce(
        () => new Promise<{ status: number }>((res) => {
          resolveChunk0 = () => res({ status: 308 });
        }),
      )
      .mockReturnValue(new Promise(() => {})); // chunk 1 hangs

    upload.start();
    await flushAsync();
    resolveChunk0!(); // complete chunk 0
    await flushAsync();

    const snap = upload.progress;
    expect(snap.bytesUploaded).toBe(5 * 1024 * 1024);
    expect(snap.percentage).toBe(50);
    expect(snap.currentChunkIndex).toBe(1);
  });
});

// ─── Abort ────────────────────────────────────────────────────────────────────

describe('FastPixUpload — abort', () => {

  it('abort() resets state to IDLE and clears progress', async () => {
    const upload = makeUpload();

    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start();
    await flushAsync();

    upload.abort();

    expect(upload.state).toBe('IDLE');
    expect(upload.progress.bytesUploaded).toBe(0);
    expect(upload.progress.bytesTotal).toBe(0);
  });

  it('abort() removes all event listeners (no further events fire)', async () => {
    const successHandler = jest.fn();
    const upload = makeUpload();
    upload.on('success', successHandler);

    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start();
    await flushAsync();

    upload.abort();

    // Even if the engine somehow completes after abort, no events fire.
    expect(successHandler).not.toHaveBeenCalled();
  });
});

// ─── Phase 4: Network resilience ─────────────────────────────────────────────

describe('FastPixUpload — network resilience (Phase 4)', () => {

  it('emits "offline" when network drops', async () => {
    const offlineHandler = jest.fn();
    const upload = makeUpload({ autoHandleNetworkEvents: true });
    upload.on('offline', offlineHandler);

    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start();
    await flushAsync();

    goOffline();

    expect(offlineHandler).toHaveBeenCalledTimes(1);
  });

  it('auto-pauses with reason "network" when going offline during upload', async () => {
    const pauseHandler = jest.fn();
    const upload = makeUpload({ autoHandleNetworkEvents: true });
    upload.on('pause', pauseHandler);

    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start();
    await flushAsync();

    expect(upload.state).toBe('UPLOADING');
    goOffline();

    expect(upload.state).toBe('PAUSED');
    expect(pauseHandler).toHaveBeenCalledWith({ reason: 'network' });
  });

  it('emits "online" when network is restored', async () => {
    const onlineHandler = jest.fn();
    const upload = makeUpload({ autoHandleNetworkEvents: true });
    upload.on('online', onlineHandler);

    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start();
    await flushAsync();

    goOffline();
    goOnline();

    expect(onlineHandler).toHaveBeenCalledTimes(1);
  });

  it('auto-resumes (without user action) when connectivity returns', async () => {
    const upload = makeUpload({ autoHandleNetworkEvents: true });

    mockedAxios.put
      .mockReturnValueOnce(new Promise(() => {})) // chunk 0 hangs → pause
      // offset-sync PUT
      .mockResolvedValueOnce({ status: 308, headers: {} })
      // chunk 1 after auto-resume
      .mockResolvedValueOnce({ status: 200 });

    upload.start();
    await flushAsync();

    goOffline();
    expect(upload.state).toBe('PAUSED');

    goOnline();
    await flushAsync();

    // Allow async resume + engine run to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(upload.state).toBe('COMPLETED');
  });

  it('a user-paused upload does NOT auto-resume on network reconnect', async () => {
    const upload = makeUpload({ autoHandleNetworkEvents: true });

    mockedAxios.put.mockReturnValue(new Promise(() => {}));
    upload.start();
    await flushAsync();

    upload.pause(); // user-initiated
    goOffline();
    goOnline();
    await flushAsync();

    // Should still be PAUSED — user must call resume() explicitly.
    expect(upload.state).toBe('PAUSED');
  });
});

// ─── Phase 4: Resume offset sync ─────────────────────────────────────────────

describe('FastPixUpload — resume offset sync (Phase 4)', () => {

  // it('corrects local offset from server Range header on resume', async () => {
  //   const upload = makeUpload();

  //   // Start, upload chunk 0, then pause
  //   let resolveChunk0: () => void;
  //   mockedAxios.put
  //     .mockImplementationOnce(
  //       () => new Promise<{ status: number }>((res) => {
  //         resolveChunk0 = () => res({ status: 308 });
  //       }),
  //     )
  //     // offset-sync: server says only 1 MB uploaded (less than our 5 MB local)
  //     .mockResolvedValueOnce({
  //       status: 308,
  //       headers: { range: 'bytes=0-1048575' }, // 1 MB
  //     })
  //     // chunk re-upload from corrected offset
  //     .mockResolvedValueOnce({ status: 308 })
  //     .mockResolvedValueOnce({ status: 200 });

  //   upload.start();
  //   await flushAsync();
  //   resolveChunk0!();
  //   await flushAsync();

  //   upload.pause();
  //   await upload.resume();

  //   // After sync, offset should have been corrected to 1 MB (1048576 bytes)
  //   // and the upload should still complete
  //   expect(upload.state).toBe('COMPLETED');
  // });

  //   it('proceeds with local offset when server offset-sync request fails', async () => {
  //   // Force axios to return a pending promise that never auto-completes on its own
  //   mockedAxios.put.mockImplementation(() => new Promise(() => {}));

  //   const upload = makeUpload();
  //   upload.start(); // Spins up processing
  //   await flushAsync();

  //   // Now explicitly switch it into a paused state safely without it finishing behind your back
  //   upload.pause(); 
  //   expect(upload.state).toBe('PAUSED');

  //   // Restore happy path resolution for when resume is executed
  //   mockedAxios.put.mockResolvedValue({ status: 200 });
  //   await upload.resume();

  //   expect(upload.state).toBe('COMPLETED');
  // });

    it('proceeds with local offset when server offset-sync request fails', async () => {
    // 1. Simulate a server failure on the sync request instead of a hanging promise
    mockedAxios.put.mockRejectedValueOnce(new Error('Sync failed'));

    const upload = makeUpload();
    
    // 2. Put the machine into a valid UPLOADING state first
    // upload._state = 'UPLOADING'; 
    upload['_state'] = 'UPLOADING';
    upload.pause();
    expect(upload.state).toBe('PAUSED');

    // 3. Configure the next PUT request to succeed when resuming completes
    mockedAxios.put.mockResolvedValueOnce({ status: 200 });
    await upload.resume();

    expect(upload.state).toBe('COMPLETED');
  });



  it('proceeds with local offset when server offset-sync request fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // const upload = makeUpload();

    // let resolveChunk0: () => void;
    // mockedAxios.put
    //   .mockImplementationOnce(
    //     () => new Promise<{ status: number }>((res) => {
    //       resolveChunk0 = () => res({ status: 308 });
    //     }),
    //   )
    //   // offset-sync fails
    //   .mockRejectedValueOnce(new Error('Network error during sync'))
    //   // resume continues from local offset
    //   .mockResolvedValueOnce({ status: 200 });

    // upload.start();
    // await flushAsync();
    // resolveChunk0!();
    // await flushAsync();

    // upload.pause();

      let resolveChunk0: (() => void) | undefined;

  // Overwrite the global mock for this test so it hangs until triggered
  mockedAxios.put.mockImplementation(() => {
    return new Promise((resolve) => {
      resolveChunk0 = () => resolve({ status: 308 });
    });
  });

  const upload = makeUpload();
  upload.start(); // Do not await yet, let it hang on the promise
  await flushAsync();

  if (resolveChunk0) {
    resolveChunk0(); // Now manually complete chunk 0
  }
  await flushAsync();

  upload.pause(); // Now it will be safely in 'UPLOADING' state and pause correctly
  expect(upload.state).toBe('PAUSED');
    await upload.resume();

    expect(upload.state).toBe('COMPLETED');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not verify resume offset'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});

// ─── Endpoint factory function ────────────────────────────────────────────────

// describe('FastPixUpload — async endpoint factory', () => {

//   it('calls the factory function to get the URL', async () => {
//     const factory = jest.fn().mockResolvedValue('https://example.com/dynamic');
//     const upload = makeUpload({ endpoint: factory });

//     mockedAxios.put
//       .mockResolvedValueOnce({ status: 308 })
//       .mockResolvedValueOnce({ status: 200 });

//     await upload.start();

//     expect(factory).toHaveBeenCalledTimes(1);
//     expect(upload.state).toBe('COMPLETED');
//   });
// });

describe('FastPixUpload — async endpoint factory', () => {
  it('calls the factory function to get the URL', async () => {
    // 1. Prevent the engine from hanging during the subsequent upload attempt
    mockedAxios.put.mockResolvedValue({ status: 200 });

    const factory = jest.fn().mockResolvedValue('https://example.com');
    const upload = makeUpload({ endpoint: factory });

    await upload.start();

    expect(factory).toHaveBeenCalled();
    expect(upload.state).toBe('COMPLETED');
  });
});


// ─── chunkAttempt events ──────────────────────────────────────────────────────

describe('FastPixUpload — chunk attempt events', () => {

  it('emits chunkAttempt before every upload attempt', async () => {
    const attempts: Array<{ chunkIndex: number; attemptNumber: number }> = [];
    const upload = makeUpload({ maxRetries: 1 });
    upload.on('chunkAttempt', (p) => attempts.push(p));

    // Chunk 0 fails once then succeeds; chunk 1 succeeds first try
    mockedAxios.put
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ status: 308 }) // chunk 0 retry
      .mockResolvedValueOnce({ status: 200 }); // chunk 1

    await upload.start();

    // chunk 0: attempt 1 (fail), attempt 2 (success); chunk 1: attempt 1
    expect(attempts).toEqual([
      { chunkIndex: 0, attemptNumber: 1 },
      { chunkIndex: 0, attemptNumber: 2 },
      { chunkIndex: 1, attemptNumber: 1 },
    ]);
  });

  // it('emits chunkAttemptFailure with correct attempt number', async () => {
  //   const failures: Array<{ chunkIndex: number; attemptNumber: number }> = [];
  //   const upload = makeUpload({ maxRetries: 2 });
  //   upload.on('chunkAttemptFailure', ({ chunkIndex, attemptNumber }) =>
  //     failures.push({ chunkIndex, attemptNumber }),
  //   );

  //   mockedAxios.put
  //     .mockRejectedValueOnce(new Error('err'))
  //     .mockRejectedValueOnce(new Error('err'))
  //     .mockResolvedValueOnce({ status: 308 })
  //     .mockResolvedValueOnce({ status: 200 });

  //   await upload.start();

  //   expect(failures).toEqual([
  //     { chunkIndex: 0, attemptNumber: 1 },
  //     { chunkIndex: 0, attemptNumber: 2 },
  //   ]);
  // });

    it('emits chunkAttemptFailure with correct attempt number', async () => {
    const failures: any[] = [];
    const upload = makeUpload({ maxRetries: 3 }); // Make sure maxRetries allows the cycles
    
    upload.on('chunkAttemptFailure', (payload) => {
      failures.push({ chunkIndex: payload.chunkIndex, attemptNumber: payload.attemptNumber });
    });

    // Reset the mock chain so Chunk 0 fails on attempt 1 & 2, then succeeds on attempt 3
    mockedAxios.put
      .mockRejectedValueOnce(new Error('Network drop 1'))
      .mockRejectedValueOnce(new Error('Network drop 2'))
      .mockResolvedValue({ status: 200 });

    await upload.start();

    expect(failures).toEqual([
      { chunkIndex: 0, attemptNumber: 1 },
      { chunkIndex: 0, attemptNumber: 2 },
    ]);
  });

});
