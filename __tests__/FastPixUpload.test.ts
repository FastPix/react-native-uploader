/**
 * FastPixUpload.test.ts
 *
 * Integration-level tests for the public FastPixUpload class.
 * All mock variables are created INSIDE jest.mock() factories to avoid
 * the hoisting-before-initialization error.
 * References are retrieved via require() inside beforeEach / test bodies.
 */

import { FastPixUpload } from '../src/core/FastPixUpload';
import type { FastPixUploadOptions } from '../src/types';

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
// stat is created inline so it is available when the hoisted factory runs.
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
// Inline jest.fn() calls inside the factory; retrieve via getUploadEngineMock().
jest.mock('../src/core/UploadEngine', () => ({
  UploadEngine: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue({ success: true }),
    abort: jest.fn(),
    setStartOffset: jest.fn(),
  })),
}));


// ── NetworkMonitor ────────────────────────────────────────────────────────────
// capturedNetworkCallback is prefixed with "mock" so Jest allows it in the factory.
let mockCapturedNetworkCb: ((status: 'online' | 'offline' | 'unknown') => void) | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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
    mockCapturedNetworkCb = null;
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

    it('is a no-op when not IDLE (warns)', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      await upload.start();

      const warnMock = (require('../src/utils/logger') as { warn: jest.Mock }).warn;
      const before = warnMock.mock.calls.length;
      await upload.start(); // state is now COMPLETED
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
      // Override run() on the next instance
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementationOnce(() => ({
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

    it('transitions to FAILED when file size is 0', async () => {
      getMockStat().mockResolvedValue({ size: 0 });
      const upload = buildUpload();
      const errorCb = jest.fn();
      upload.on('error', errorCb);

      await upload.start();
      expect(errorCb).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('empty') }),
      );
    });

    it('transitions to FAILED when file exceeds maxFileSize', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });
      const upload = buildUpload({ maxFileSize: FILE_SIZE - 1 });
      const errorCb = jest.fn();
      upload.on('error', errorCb);

      await upload.start();
      expect(errorCb).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('exceeds') }),
      );
    });
  });

  // ── pause() ────────────────────────────────
  describe('pause()', () => {
    it('transitions UPLOADING → PAUSED and emits pause with reason "user"', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });

      let resolveEngine!: (v: { success: boolean; error?: Error }) => void;
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementationOnce(() => ({
        run: jest.fn().mockReturnValue(
          new Promise<{ success: boolean; error?: Error }>((res) => { resolveEngine = res; }),
        ),
        abort: jest.fn(),
        setStartOffset: jest.fn(),
      }));

      const upload = buildUpload();
      const pauseCb = jest.fn();
      upload.on('pause', pauseCb);

      upload.start(); // intentionally not awaited
      await new Promise((r) => setTimeout(r, 0)); // let microtasks settle to UPLOADING

      upload.pause();
      expect(upload.state).toBe('PAUSED');
      expect(pauseCb).toHaveBeenCalledWith({ reason: 'user' });

      resolveEngine({ success: false, error: new Error('Upload was aborted.') });
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
    it('is a no-op when state is already IDLE', () => {
      const upload = buildUpload();
      expect(() => upload.abort()).not.toThrow();
      expect(upload.state).toBe('IDLE');
    });

    it('transitions to IDLE and emits "abort" event', async () => {
      getMockStat().mockResolvedValue({ size: FILE_SIZE });

      let resolveEngine!: (v: { success: boolean }) => void;
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementationOnce(() => ({
        run: jest.fn().mockReturnValue(
          new Promise<{ success: boolean }>((res) => { resolveEngine = res; }),
        ),
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
      const { UploadEngine } = require('../src/core/UploadEngine') as { UploadEngine: jest.Mock };
      UploadEngine.mockImplementationOnce(() => ({
        run: jest.fn().mockReturnValue(
          new Promise<{ success: boolean }>((res) => { resolveEngine = res; }),
        ),
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
    it('on() returns an unsubscribe function that prevents future calls', async () => {
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

    it('records timestamps (at) as positive numbers', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      await upload.start();
      upload.stateHistory.forEach((entry) => {
        expect(typeof entry.at).toBe('number');
        expect(entry.at).toBeGreaterThan(0);
      });
    });
  });
});