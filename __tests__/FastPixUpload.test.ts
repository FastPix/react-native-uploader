import { FastPixUpload } from '../src/core/FastPixUpload';
import type { FastPixUploadOptions } from '../src/types';

// Logger 
jest.mock('../src/utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

// SDK config 
jest.mock('../src/utils/config', () => ({ SDK_CONFIG: { enableLogs: false } }));

// validation
jest.mock('../src/utils/validation', () => ({
  validateAndNormalizeOptions: jest.fn((opts: FastPixUploadOptions) => ({
    endpoint: opts.endpoint ?? 'https://example.com/upload',
    fileUri: opts.fileUri ?? 'file:///video.mp4',
    chunkSize: 5 * 1024,
    maxRetries: 2,
    retryDelay: 0,
    maxFileSize: 0,
    enableLogs: false,
  })),
  resolveEndpoint: jest.fn(async (e: string | (() => Promise<string>)) =>
    typeof e === 'function' ? e() : e,
  ),
}));

//  ChunkEngine
jest.mock('../src/core/ChunkEngine', () => ({
  chunkIndexForOffset: jest.fn(() => 0),
}));

//  react-native-blob-util 
const mockStat = jest.fn();
jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: { stat: mockStat },
  },
}));

//  UploadEngine 
let mockEngineRun = jest.fn();
let mockEngineAbort = jest.fn();
let mockEngineSetStartOffset = jest.fn();

jest.mock('../src/core/UploadEngine', () => ({
  UploadEngine: jest.fn().mockImplementation(() => ({
    run: mockEngineRun,
    abort: mockEngineAbort,
    setStartOffset: mockEngineSetStartOffset,
  })),
}));

//  NetworkMonitor 
let capturedNetworkCallback: ((status: 'online' | 'offline' | 'unknown') => void) | null = null;

const mockNetworkStart = jest.fn();
const mockNetworkStop = jest.fn();
const mockNetworkOnChange = jest.fn((cb: (s: string) => void) => {
  capturedNetworkCallback = cb as (status: 'online' | 'offline' | 'unknown') => void;
  return jest.fn(); // cleanup noop
});

jest.mock('../src/core/NetworkMonitor', () => ({
  NetworkMonitor: jest.fn().mockImplementation(() => ({
    start: mockNetworkStart,
    stop: mockNetworkStop,
    onChange: mockNetworkOnChange,
  })),
}));

//  Helpers 
const FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const defaultOpts = (): FastPixUploadOptions => ({
  endpoint: 'https://example.com/upload',
  fileUri: 'file:///video.mp4',
});

function buildUpload(overrides: Partial<FastPixUploadOptions> = {}): FastPixUpload {
  return new FastPixUpload({ ...defaultOpts(), ...overrides });
}

function setupSuccessfulEngine(): void {
  mockStat.mockResolvedValue({ size: FILE_SIZE });
  mockEngineRun.mockResolvedValue({ success: true });
}

describe('FastPixUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedNetworkCallback = null;
    mockEngineRun = jest.fn().mockResolvedValue({ success: true });
    mockEngineAbort = jest.fn();
    mockEngineSetStartOffset = jest.fn();
  });

  // ── constructor ────────────────────────────
  describe('constructor', () => {
    it('initialises state as IDLE', () => {
      const upload = buildUpload();
      expect(upload.state).toBe('IDLE');
    });

    it('initialises progress with zeroed values', () => {
      const upload = buildUpload();
      const p = upload.progress;
      expect(p.bytesUploaded).toBe(0);
      expect(p.bytesTotal).toBe(0);
      expect(p.percentage).toBe(0);
      expect(p.state).toBe('IDLE');
    });

    it('exposes an empty stateHistory', () => {
      const upload = buildUpload();
      expect(upload.stateHistory).toHaveLength(0);
    });
  });

  // start() 
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

    it('is a no-op when already started', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      await upload.start();
      // Second call after COMPLETED → should warn and return early
      const warnMock = jest.requireMock('../utils/logger').warn;
      const before = warnMock.mock.calls.length;
      await upload.start();
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
      mockStat.mockResolvedValue({ size: FILE_SIZE });
      mockEngineRun.mockResolvedValue({
        success: false,
        error: new Error('chunk failed'),
      });
      const upload = buildUpload();
      const errorCb = jest.fn();
      upload.on('error', errorCb);

      await upload.start();

      expect(upload.state).toBe('FAILED');
      expect(errorCb).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'chunk failed', retriable: false }),
      );
    });

    it('transitions to FAILED and emits "error" when stat throws', async () => {
      mockStat.mockRejectedValue(new Error('File not found'));
      const upload = buildUpload();
      const errorCb = jest.fn();
      upload.on('error', errorCb);

      await upload.start();

      expect(upload.state).toBe('FAILED');
      expect(errorCb).toHaveBeenCalled();
    });

    it('throws when file size is 0', async () => {
      mockStat.mockResolvedValue({ size: 0 });
      const upload = buildUpload();
      const errorCb = jest.fn();
      upload.on('error', errorCb);

      await upload.start();
      expect(errorCb).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('empty') }),
      );
    });

    it('throws when file exceeds maxFileSize', async () => {
      mockStat.mockResolvedValue({ size: FILE_SIZE });
      const upload = buildUpload({ maxFileSize: FILE_SIZE - 1 } as FastPixUploadOptions);
      const errorCb = jest.fn();
      upload.on('error', errorCb);

      await upload.start();
      expect(errorCb).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('exceeds') }),
      );
    });
  });

  // pause() 
  describe('pause()', () => {
    it('transitions UPLOADING → PAUSED', async () => {
      mockStat.mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      mockEngineRun.mockReturnValue(
        new Promise<{ success: boolean }>((res) => {
          resolveEngine = res;
        }),
      );

      const upload = buildUpload();
      upload.start(); // kick off (don't await)
      // Wait for UPLOADING state
      await new Promise((r) => setTimeout(r, 0));

      upload.pause();
      expect(upload.state).toBe('PAUSED');
      resolveEngine({ success: false, error: new Error('Upload was aborted.') } as { success: boolean });
    });

    it('emits "pause" event with reason "user"', async () => {
      mockStat.mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      mockEngineRun.mockReturnValue(
        new Promise<{ success: boolean }>((res) => { resolveEngine = res; }),
      );

      const upload = buildUpload();
      const pauseCb = jest.fn();
      upload.on('pause', pauseCb);

      upload.start();
      await new Promise((r) => setTimeout(r, 0));
      upload.pause();

      expect(pauseCb).toHaveBeenCalledWith({ reason: 'user' });
      resolveEngine({ success: false, error: new Error('aborted') } as { success: boolean });
    });

    it('is a no-op when state is not UPLOADING', () => {
      const upload = buildUpload();
      expect(() => upload.pause()).not.toThrow();
      expect(upload.state).toBe('IDLE');
    });
  });

  // resume()
  describe('resume()', () => {
    it('is a no-op when state is not PAUSED', async () => {
      const upload = buildUpload();
      await expect(upload.resume()).resolves.toBeUndefined();
      expect(upload.state).toBe('IDLE');
    });
  });

  // abort() 
  describe('abort()', () => {
    it('is a no-op when state is IDLE', () => {
      const upload = buildUpload();
      expect(() => upload.abort()).not.toThrow();
      expect(upload.state).toBe('IDLE');
    });

    it('transitions to IDLE and emits "abort" event', async () => {
      mockStat.mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      mockEngineRun.mockReturnValue(
        new Promise<{ success: boolean }>((res) => { resolveEngine = res; }),
      );

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

    it('resets all upload state fields', async () => {
      mockStat.mockResolvedValue({ size: FILE_SIZE });
      let resolveEngine!: (v: { success: boolean }) => void;
      mockEngineRun.mockReturnValue(
        new Promise<{ success: boolean }>((res) => { resolveEngine = res; }),
      );

      const upload = buildUpload();
      upload.start();
      await new Promise((r) => setTimeout(r, 0));
      upload.abort();

      const p = upload.progress;
      expect(p.bytesTotal).toBe(0);
      expect(p.bytesUploaded).toBe(0);
      resolveEngine({ success: false });
    });
  });

  // on() / off() 
  describe('on() / off()', () => {
    it('on() returns an unsubscribe function', async () => {
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

  // progress getter 
  describe('progress getter', () => {
    it('shows 0% when IDLE', () => {
      const upload = buildUpload();
      expect(upload.progress.percentage).toBe(0);
    });

    it('includes currentChunkIndex in the snapshot', () => {
      const upload = buildUpload();
      expect(upload.progress).toHaveProperty('currentChunkIndex');
    });
  });

  // stateHistory 
  describe('stateHistory', () => {
    it('records transitions in order', async () => {
      setupSuccessfulEngine();
      const upload = buildUpload();
      await upload.start();

      const history = upload.stateHistory;
      expect(history[0]).toMatchObject({ from: 'IDLE', to: 'STARTED' });
      expect(history[history.length - 1]).toMatchObject({ to: 'COMPLETED' });
    });

    it('records timestamps (at) as numbers', async () => {
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