/**
 * FastPixUpload.test.ts
 * Lives in __tests__/ at the project root.
 * All paths are relative to __tests__/, i.e. src is at ../src/
 */

import { FastPixUpload } from '../src/core/FastPixUpload';
import type { FastPixUploadOptions } from '../src/types';

// ── NetInfo — intercept native module before it is touched ────────────────────
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(),
  },
}));

// ── Logger ────────────────────────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

// ── SDK config ────────────────────────────────────────────────────────────────
jest.mock('../src/utils/config', () => ({ SDK_CONFIG: { enableLogs: false } }));

// ── validation ────────────────────────────────────────────────────────────────
jest.mock('../src/utils/validation', () => ({
  validateAndNormalizeOptions: jest.fn((opts: FastPixUploadOptions) => ({
    endpoint: opts.endpoint ?? 'https://example.com/upload',
    fileUri: opts.fileUri ?? 'file:///video.mp4',
    chunkSize: 5 * 1024,
    maxRetries: 2,
    retryDelay: 0,
    maxFileSize: opts.maxFileSize ?? 0,
    enableLogs: false,
  })),
  resolveEndpoint: jest.fn(async (e: string | (() => Promise<string>)) =>
    typeof e === 'function' ? e() : e,
  ),
}));

// ── ChunkEngine ───────────────────────────────────────────────────────────────
jest.mock('../src/core/ChunkEngine', () => ({
  chunkIndexForOffset: jest.fn(() => 0),
}));

// ── react-native-blob-util ────────────────────────────────────────────────────
jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: { stat: jest.fn() },
  },
}));

function getMockStat(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('react-native-blob-util').default.fs.stat as jest.Mock;
}

// ── UploadEngine ──────────────────────────────────────────────────────────────
jest.mock('../src/core/UploadEngine', () => ({
  UploadEngine: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue({ success: true }),
    abort: jest.fn(),
    setStartOffset: jest.fn(),
  })),
}));

// ── NetworkMonitor ────────────────────────────────────────────────────────────
// Capture the onChange callback so tests can trigger network events.
// eslint-disable-next-line no-var
var capturedNetworkCallback: ((status: string) => void) | null = null;
// eslint-disable-next-line no-var
var capturedTransportCallback:
  | ((type: string, previousType: string | null) => void)
  | null = null;

jest.mock('../src/core/NetworkMonitor', () => ({
  NetworkMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    onChange: jest.fn((cb: (s: string) => void) => {
      capturedNetworkCallback = cb;
      return jest.fn();
    }),
    onTransportChange: jest.fn((cb: (t: string, p: string | null) => void) => {
      capturedTransportCallback = cb;
      return jest.fn();
    }),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const FILE_SIZE = 10 * 1024 * 1024;

const defaultOpts = (): FastPixUploadOptions => ({
  endpoint: 'https://example.com/upload',
  fileUri: 'file:///video.mp4',
});

function buildUpload(overrides: Partial<FastPixUploadOptions> = {}): FastPixUpload {
  return new FastPixUpload({ ...defaultOpts(), ...overrides });
}

function setupSuccessfulEngine(): void {
  getMockStat().mockResolvedValue({ size: FILE_SIZE });
}

// ─────────────────────────────────────────────
describe('FastPixUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedNetworkCallback = null;
    capturedTransportCallback = null;

    // Re-wire UploadEngine — clearAllMocks() wipes all mockImplementations.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
    UploadEngine.mockImplementation(() => ({
      run: jest.fn().mockResolvedValue({ success: true }),
      abort: jest.fn(),
      setStartOffset: jest.fn(),
    }));

    // Re-wire validateAndNormalizeOptions — same reason.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const validation = require('../src/utils/validation') as {
      validateAndNormalizeOptions: jest.Mock;
      resolveEndpoint: jest.Mock;
    };
    validation.validateAndNormalizeOptions.mockImplementation((opts: FastPixUploadOptions) => ({
      endpoint: opts.endpoint ?? 'https://example.com/upload',
      fileUri: opts.fileUri ?? 'file:///video.mp4',
      chunkSize: 5 * 1024,
      maxRetries: 2,
      retryDelay: 0,
      maxFileSize: opts.maxFileSize ?? 0,
      enableLogs: false,
    }));
    validation.resolveEndpoint.mockImplementation(
      async (e: string | (() => Promise<string>)) => (typeof e === 'function' ? e() : e),
    );
  });

  // ── constructor ────────────────────────────
  describe('constructor', () => {
    it('initialises state as IDLE', () => {
      expect(buildUpload().state).toBe('IDLE');
    });

    it('initialises progress with zeroed values', () => {
      const p = buildUpload().progress;
      expect(p.bytesUploaded).toBe(0);
      expect(p.bytesTotal).toBe(0);
      expect(p.percentage).toBe(0);
      expect(p.state).toBe('IDLE');
    });

    it('exposes an empty stateHistory', () => {
      expect(buildUpload().stateHistory).toHaveLength(0);
    });
  });

  // ── start() ────────────────────────────────
  describe('start()', () => {
    it('transitions IDLE → STARTED → UPLOADING → COMPLETED on success', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      const states: string[] = [];
      upload.on('stateChange', ({ to }) => states.push(to));
      await upload.start();
      expect(states).toEqual(expect.arrayContaining(['STARTED', 'UPLOADING', 'COMPLETED']));
      expect(upload.state).toBe('COMPLETED');
    });

    it('is a no-op when not in IDLE state', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      await upload.start();
      const warnMock = jest.requireMock('../src/utils/logger').warn;
      const before = warnMock.mock.calls.length;
      await upload.start(); // already COMPLETED
      expect(warnMock.mock.calls.length).toBeGreaterThan(before);
    });

    it('emits "started" event with fileSize and endpoint', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      const startedCb = jest.fn();
      upload.on('started', startedCb);
      await upload.start();
      expect(startedCb).toHaveBeenCalledWith({
        fileSize: FILE_SIZE,
        endpoint: 'https://example.com/upload',
      });
    });

    it('emits "success" event on completion', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      const successCb = jest.fn();
      upload.on('success', successCb);
      await upload.start();
      expect(successCb).toHaveBeenCalledTimes(1);
    });

    it('transitions to FAILED and emits "error" when engine fails', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockResolvedValue({ success: false, error: new Error('chunk failed') }),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const errorCb = jest.fn();
      upload.on('error', errorCb);
      await upload.start();
      expect(upload.state).toBe('FAILED');
      expect(errorCb).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'chunk failed', retriable: false }),
      );
    });

    it('transitions to FAILED when stat throws', async () => {
      getMockStat().mockRejectedValue(new Error('File not found'));
      const upload = buildUpload();
      const errorCb = jest.fn();
      upload.on('error', errorCb);
      await upload.start();
      expect(upload.state).toBe('FAILED');
      expect(errorCb).toHaveBeenCalled();
    });

    it('emits error when file size is 0', async () => {
      getMockStat().mockResolvedValue({ size: 0 });
      const upload = buildUpload();
      const errorCb = jest.fn();
      upload.on('error', errorCb);
      await upload.start();
      expect(errorCb).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('empty') }),
      );
    });

  });

  // ── pause() ────────────────────────────────
  describe('pause()', () => {
    it('transitions UPLOADING → PAUSED and emits "pause" with reason "user"', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean; error?: Error }) => void;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockReturnValue(new Promise<{ success: boolean }>((res) => { resolveEngine = res; })),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const pauseCb = jest.fn();
      upload.on('pause', pauseCb);
      upload.start(); // don't await
      await new Promise((r) => setTimeout(r, 0)); // flush to UPLOADING

      upload.pause();
      expect(upload.state).toBe('PAUSED');
      expect(pauseCb).toHaveBeenCalledWith({ reason: 'user' });
      resolveEngine({ success: false, error: new Error('aborted') });
    });

    it('is a no-op when state is not UPLOADING', () => {
      const upload = buildUpload();
      expect(() => upload.pause()).not.toThrow();
      expect(upload.state).toBe('IDLE');
    });
  });

  // ── resume() ──────────────────────────────
  describe('resume()', () => {
    it('is a no-op when state is not PAUSED', async () => {
      const upload = buildUpload();
      await expect(upload.resume()).resolves.toBeUndefined();
      expect(upload.state).toBe('IDLE');
    });
  });

  // ── abort() ────────────────────────────────
  describe('abort()', () => {
    it('is a no-op when state is IDLE', () => {
      const upload = buildUpload();
      expect(() => upload.abort()).not.toThrow();
      expect(upload.state).toBe('IDLE');
    });

    it('transitions to IDLE and emits "abort"', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockReturnValue(new Promise<{ success: boolean }>((res) => { resolveEngine = res; })),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const abortCb = jest.fn();
      upload.on('abort', abortCb);
      upload.start();
      await new Promise((r) => setTimeout(r, 0));
      upload.abort();
      expect(upload.state).toBe('IDLE');
      expect(abortCb).toHaveBeenCalledTimes(1);
      resolveEngine({ success: false });
    });

    it('resets bytesTotal to 0 after abort', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockReturnValue(new Promise<{ success: boolean }>((res) => { resolveEngine = res; })),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      upload.start();
      await new Promise((r) => setTimeout(r, 0));
      upload.abort();
      expect(upload.progress.bytesTotal).toBe(0);
      resolveEngine({ success: false });
    });
  });

  // ── on() / off() ──────────────────────────
  describe('on() / off()', () => {
    it('on() returns an unsubscribe function that stops delivery', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      const cb = jest.fn();
      const unsub = upload.on('success', cb);
      unsub();
      await upload.start();
      expect(cb).not.toHaveBeenCalled();
    });

    it('off() removes the specified listener', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      const cb = jest.fn();
      upload.on('success', cb);
      upload.off('success', cb);
      await upload.start();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ── progress getter ────────────────────────
  describe('progress getter', () => {
    it('shows 0% when IDLE', () => {
      expect(buildUpload().progress.percentage).toBe(0);
    });

    it('includes currentChunkIndex in the snapshot', () => {
      expect(buildUpload().progress).toHaveProperty('currentChunkIndex');
    });
  });

  // ── stateHistory ──────────────────────────
  describe('stateHistory', () => {
    it('records transitions in order', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      await upload.start();
      const history = upload.stateHistory;
      expect(history[0]).toMatchObject({ from: 'IDLE', to: 'STARTED' });
      expect(history[history.length - 1]).toMatchObject({ to: 'COMPLETED' });
    });

    it('records timestamps as numbers', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      await upload.start();
      upload.stateHistory.forEach((e) => {
        expect(typeof e.at).toBe('number');
        expect(e.at).toBeGreaterThan(0);
      });
    });
  });

  // ── network handling ──────────────────────
  describe('network handling', () => {
    it('starts NetworkMonitor on upload start', async () => {
      setupSuccessfulEngine();
      // The NetworkMonitor instance is created in the FastPixUpload constructor.
      // Capture it via the mock's return value before starting.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { NetworkMonitor } = require('../src/core/NetworkMonitor') as { NetworkMonitor: jest.Mock };
      const upload = buildUpload();
      // The most recent instance is whatever the constructor just created.
      const instance = NetworkMonitor.mock.results[NetworkMonitor.mock.results.length - 1]?.value as {
        start: jest.Mock;
      };
      await upload.start();
      expect(instance.start).toHaveBeenCalledTimes(1);
    });

    it('pauses upload and emits "pause" with reason "network" when going offline', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean; error?: Error }) => void;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockReturnValue(new Promise<{ success: boolean }>((res) => { resolveEngine = res; })),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const pauseCb = jest.fn();
      upload.on('pause', pauseCb);
      upload.start();
      await new Promise((r) => setTimeout(r, 0));

      capturedNetworkCallback?.('offline');
      expect(upload.state).toBe('PAUSED');
      expect(pauseCb).toHaveBeenCalledWith({ reason: 'network' });
      resolveEngine({ success: false, error: new Error('aborted') });
    });

    it('emits "offline" event when going offline', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockReturnValue(new Promise<{ success: boolean }>((res) => { resolveEngine = res; })),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const offlineCb = jest.fn();
      upload.on('offline', offlineCb);
      upload.start();
      await new Promise((r) => setTimeout(r, 0));
      capturedNetworkCallback?.('offline');
      expect(offlineCb).toHaveBeenCalledTimes(1);
      resolveEngine({ success: false });
    });

    it('emits "online" event when going online', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockReturnValue(new Promise<{ success: boolean }>((res) => { resolveEngine = res; })),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const onlineCb = jest.fn();
      upload.on('online', onlineCb);
      upload.start();
      await new Promise((r) => setTimeout(r, 0));
      capturedNetworkCallback?.('online');
      expect(onlineCb).toHaveBeenCalledTimes(1);
      resolveEngine({ success: false });
    });

    it('restarts the upload (aborts engine) on a transport switch while uploading', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      const abortSpy = jest.fn();
      let resolveEngine!: (v: { success: boolean }) => void;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementation(() => ({
        run: jest.fn().mockReturnValue(new Promise<{ success: boolean }>((res) => { resolveEngine = res; })),
        abort: abortSpy,
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const pauseCb = jest.fn();
      upload.on('pause', pauseCb);
      upload.start();
      await new Promise((r) => setTimeout(r, 0));

      // wifi -> cellular while the device stays online.
      capturedTransportCallback?.('cellular', 'wifi');

      expect(abortSpy).toHaveBeenCalled();
      expect(pauseCb).toHaveBeenCalledWith({ reason: 'network' });
      resolveEngine({ success: false });
    });
  });
});