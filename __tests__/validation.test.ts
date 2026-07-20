import {
  validateAndNormalizeOptions,
  resolveEndpoint,
  MIN_CHUNK_SIZE_KB,
  MAX_CHUNK_SIZE_KB,
  DEFAULT_CHUNK_SIZE_KB,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
} from '../src/utils/validation';
import type { FastPixUploadOptions } from '../src/types';

jest.mock('../src/utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const VALID_ENDPOINT = 'https://example.com/upload';
const VALID_FILE_URI = 'file:///storage/video.mp4';

const validOpts = (): FastPixUploadOptions => ({
  endpoint: VALID_ENDPOINT,
  fileUri: VALID_FILE_URI,
});

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
describe('exported constants', () => {
  it('MIN_CHUNK_SIZE_KB is 5 MB in KB', () => expect(MIN_CHUNK_SIZE_KB).toBe(5 * 1024));
  it('MAX_CHUNK_SIZE_KB is 500 MB in KB', () => expect(MAX_CHUNK_SIZE_KB).toBe(500 * 1024));
  it('DEFAULT_CHUNK_SIZE_KB is 5 MB in KB', () => expect(DEFAULT_CHUNK_SIZE_KB).toBe(5 * 1024));
  it('DEFAULT_MAX_RETRIES is 5', () => expect(DEFAULT_MAX_RETRIES).toBe(5));
  it('DEFAULT_RETRY_DELAY_MS is 1000', () => expect(DEFAULT_RETRY_DELAY_MS).toBe(1000));
});

// ─────────────────────────────────────────────
// validateAndNormalizeOptions
// ─────────────────────────────────────────────
describe('validateAndNormalizeOptions()', () => {
  describe('guard — missing options object', () => {
    it('throws when opts is null/undefined', () => {
      // @ts-expect-error intentional bad input
      expect(() => validateAndNormalizeOptions(null)).toThrow(
        '[FastPix] Options object is required.',
      );
    });
  });

  describe('endpoint validation', () => {
    it('throws when endpoint is missing', () => {
      // @ts-expect-error intentional bad input
      expect(() => validateAndNormalizeOptions({ fileUri: VALID_FILE_URI })).toThrow(
        '"endpoint" is required',
      );
    });

    it('throws when endpoint is a number', () => {
      // @ts-expect-error intentional bad input
      expect(() => validateAndNormalizeOptions({ endpoint: 42, fileUri: VALID_FILE_URI })).toThrow(
        '"endpoint" must be a string URL or an async function',
      );
    });

    it('accepts a string endpoint', () => {
      expect(() => validateAndNormalizeOptions(validOpts())).not.toThrow();
    });

    it('accepts an async function endpoint', () => {
      const opts: FastPixUploadOptions = {
        endpoint: async () => VALID_ENDPOINT,
        fileUri: VALID_FILE_URI,
      };
      expect(() => validateAndNormalizeOptions(opts)).not.toThrow();
    });
  });

  describe('fileUri validation', () => {
    it('throws when fileUri is missing', () => {
      // @ts-expect-error intentional bad input
      expect(() => validateAndNormalizeOptions({ endpoint: VALID_ENDPOINT })).toThrow(
        '"fileUri" is required',
      );
    });

    it('throws when fileUri is not a string', () => {
      // @ts-expect-error intentional bad input
      expect(() => validateAndNormalizeOptions({ endpoint: VALID_ENDPOINT, fileUri: 123 })).toThrow(
        '"fileUri" is required and must be a string',
      );
    });
  });

  describe('chunkSize validation', () => {
    it('uses DEFAULT_CHUNK_SIZE_KB when chunkSize is omitted', () => {
      const result = validateAndNormalizeOptions(validOpts());
      expect(result.chunkSize).toBe(DEFAULT_CHUNK_SIZE_KB);
    });

    it('throws when chunkSize is below minimum', () => {
      expect(() =>
        validateAndNormalizeOptions({ ...validOpts(), chunkSize: MIN_CHUNK_SIZE_KB - 1 }),
      ).toThrow(`"chunkSize" must be at least ${MIN_CHUNK_SIZE_KB} KB`);
    });

    it('throws when chunkSize exceeds maximum', () => {
      expect(() =>
        validateAndNormalizeOptions({ ...validOpts(), chunkSize: MAX_CHUNK_SIZE_KB + 1 }),
      ).toThrow(`Chunk size cannot exceed 500MB`);
    });

    it('throws when chunkSize is not a number', () => {
      // @ts-expect-error intentional bad input
      expect(() => validateAndNormalizeOptions({ ...validOpts(), chunkSize: 'big' })).toThrow(
        '"chunkSize" must be a finite number',
      );
    });

    it('accepts chunkSize exactly at the minimum', () => {
      const result = validateAndNormalizeOptions({ ...validOpts(), chunkSize: MIN_CHUNK_SIZE_KB });
      expect(result.chunkSize).toBe(MIN_CHUNK_SIZE_KB);
    });

    it('accepts chunkSize exactly at the maximum', () => {
      const result = validateAndNormalizeOptions({ ...validOpts(), chunkSize: MAX_CHUNK_SIZE_KB });
      expect(result.chunkSize).toBe(MAX_CHUNK_SIZE_KB);
    });
  });

  describe('maxRetries validation', () => {
    it('uses DEFAULT_MAX_RETRIES when omitted', () => {
      const result = validateAndNormalizeOptions(validOpts());
      expect(result.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    });

    it('accepts 0 (no retries)', () => {
      const result = validateAndNormalizeOptions({ ...validOpts(), maxRetries: 0 });
      expect(result.maxRetries).toBe(0);
    });

    it('throws when maxRetries is negative', () => {
      expect(() => validateAndNormalizeOptions({ ...validOpts(), maxRetries: -1 })).toThrow(
        '"maxRetries" must be a non-negative integer',
      );
    });

    it('throws when maxRetries is a float', () => {
      expect(() => validateAndNormalizeOptions({ ...validOpts(), maxRetries: 1.5 })).toThrow(
        '"maxRetries" must be a non-negative integer',
      );
    });
  });

  describe('retryDelay validation', () => {
    it('uses DEFAULT_RETRY_DELAY_MS when omitted', () => {
      const result = validateAndNormalizeOptions(validOpts());
      expect(result.retryDelay).toBe(DEFAULT_RETRY_DELAY_MS);
    });

    it('accepts 0 delay', () => {
      const result = validateAndNormalizeOptions({ ...validOpts(), retryDelay: 0 });
      expect(result.retryDelay).toBe(0);
    });

    it('throws when retryDelay is negative', () => {
      expect(() => validateAndNormalizeOptions({ ...validOpts(), retryDelay: -500 })).toThrow(
        '"retryDelay" must be a non-negative number',
      );
    });
  });

  describe('maxFileSize validation', () => {
    it('defaults to 0 (no limit) when omitted', () => {
      const result = validateAndNormalizeOptions(validOpts());
      expect(result.maxFileSize).toBe(0);
    });

    it('throws when maxFileSize is negative', () => {
      expect(() => validateAndNormalizeOptions({ ...validOpts(), maxFileSize: -1 })).toThrow(
        '"maxFileSize" must be a non-negative number',
      );
    });

    it('accepts a positive byte value', () => {
      const limit = 100 * 1024 * 1024; // 100 MB
      const result = validateAndNormalizeOptions({ ...validOpts(), maxFileSize: limit });
      expect(result.maxFileSize).toBe(limit);
    });
  });

  describe('returned shape', () => {
    it('returns all required fields', () => {
      const result = validateAndNormalizeOptions(validOpts());
      expect(result).toMatchObject({
        endpoint: VALID_ENDPOINT,
        fileUri: VALID_FILE_URI,
        chunkSize: DEFAULT_CHUNK_SIZE_KB,
        maxRetries: DEFAULT_MAX_RETRIES,
        retryDelay: DEFAULT_RETRY_DELAY_MS,
        maxFileSize: 0,
        enableLogs: false,
      });
    });
  });
});

// ─────────────────────────────────────────────
// resolveEndpoint
// ─────────────────────────────────────────────
describe('resolveEndpoint()', () => {
  it('returns the string directly for a static URL', async () => {
    const result = await resolveEndpoint(VALID_ENDPOINT);
    expect(result).toBe(VALID_ENDPOINT);
  });

  it('calls the factory function and returns its resolved URL', async () => {
    const factory = jest.fn().mockResolvedValue(VALID_ENDPOINT);
    const result = await resolveEndpoint(factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toBe(VALID_ENDPOINT);
  });

  it('throws when factory resolves to an empty string', async () => {
    const factory = jest.fn().mockResolvedValue('');
    await expect(resolveEndpoint(factory)).rejects.toThrow(
      'The endpoint factory function must resolve to a non-empty string URL.',
    );
  });

  it('throws when factory resolves to a non-string value', async () => {
    // jest.fn() is typed as returning `any`, so no TS error is raised here;
    // the runtime guard inside resolveEndpoint() is what we are exercising.
    const factory = jest.fn().mockResolvedValue(null as unknown);
    await expect(resolveEndpoint(factory)).rejects.toThrow(
      'The endpoint factory function must resolve to a non-empty string URL.',
    );
  });

  it('propagates rejections from the factory function', async () => {
    const factory = jest.fn().mockRejectedValue(new Error('Network down'));
    await expect(resolveEndpoint(factory)).rejects.toThrow('Network down');
  });
});