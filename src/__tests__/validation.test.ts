import {
  validateAndNormalizeOptions,
  resolveEndpoint,
  DEFAULT_CHUNK_SIZE_KB,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  MIN_CHUNK_SIZE_KB,
} from '../utils/validation';

describe('validateAndNormalizeOptions', () => {
  const validBase = {
    endpoint: 'https://example.com/signed-url',
    fileUri: 'file:///path/to/video.mp4',
  };

  it('returns normalised options with defaults applied', () => {
    const result = validateAndNormalizeOptions(validBase);
    expect(result.chunkSize).toBe(DEFAULT_CHUNK_SIZE_KB);
    expect(result.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(result.retryDelay).toBe(DEFAULT_RETRY_DELAY_MS);
    expect(result.autoHandleNetworkEvents).toBe(true);
  });

  it('preserves explicitly provided options', () => {
    const result = validateAndNormalizeOptions({
      ...validBase,
      chunkSize: 10 * 1024,
      maxRetries: 3,
      retryDelay: 2000,
      autoHandleNetworkEvents: false,
    });
    expect(result.chunkSize).toBe(10 * 1024);
    expect(result.maxRetries).toBe(3);
    expect(result.retryDelay).toBe(2000);
    expect(result.autoHandleNetworkEvents).toBe(false);
  });

  it('throws when options are missing entirely', () => {
    // @ts-expect-error — intentional bad input for test
    expect(() => validateAndNormalizeOptions(null)).toThrow('[FastPix]');
  });

  it('throws when endpoint is missing', () => {
    expect(() =>
      validateAndNormalizeOptions({ ...validBase, endpoint: '' }),
    ).toThrow('[FastPix]');
  });

  it('throws when endpoint is an invalid type', () => {
    expect(() =>
      // @ts-expect-error — intentional bad input
      validateAndNormalizeOptions({ ...validBase, endpoint: 42 }),
    ).toThrow('[FastPix]');
  });

  it('throws when fileUri is missing', () => {
    expect(() =>
      validateAndNormalizeOptions({ ...validBase, fileUri: '' }),
    ).toThrow('[FastPix]');
  });

  it('throws when chunkSize is below the minimum', () => {
    expect(() =>
      validateAndNormalizeOptions({
        ...validBase,
        chunkSize: MIN_CHUNK_SIZE_KB - 1,
      }),
    ).toThrow('[FastPix]');
  });

  it('throws when maxRetries is negative', () => {
    expect(() =>
      validateAndNormalizeOptions({ ...validBase, maxRetries: -1 }),
    ).toThrow('[FastPix]');
  });

  it('accepts a function as the endpoint', () => {
    const factory = async () => 'https://example.com/token-url';
    const result = validateAndNormalizeOptions({
      ...validBase,
      endpoint: factory,
    });
    expect(result.endpoint).toBe(factory);
  });
});

describe('resolveEndpoint', () => {
  it('returns a static string endpoint unchanged', async () => {
    const url = 'https://example.com/signed-url';
    expect(await resolveEndpoint(url)).toBe(url);
  });

  it('calls an async factory function and returns its resolved value', async () => {
    const factory = jest.fn().mockResolvedValue('https://example.com/dynamic');
    const result = await resolveEndpoint(factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toBe('https://example.com/dynamic');
  });

  it('throws when the factory resolves to an empty string', async () => {
    const factory = async () => '';
    await expect(resolveEndpoint(factory)).rejects.toThrow('[FastPix]');
  });
});
