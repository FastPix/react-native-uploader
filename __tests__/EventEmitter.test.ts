import { TypedEventEmitter } from '../src/utils/EventEmitter';

describe('TypedEventEmitter', () => {
  let emitter: TypedEventEmitter;

  beforeEach(() => {
    emitter = new TypedEventEmitter();
  });

  it('calls a registered listener when the matching event is emitted', () => {
    const handler = jest.fn();
    emitter.on('success', handler);
    emitter.emit('success', undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('passes the correct payload to the listener', () => {
    const handler = jest.fn();
    emitter.on('progress', handler);
    emitter.emit('progress', {
      bytesUploaded: 1024,
      bytesTotal: 4096,
      percentage: 25,
    });
    expect(handler).toHaveBeenCalledWith({
      bytesUploaded: 1024,
      bytesTotal: 4096,
      percentage: 25,
    });
  });

  it('supports multiple listeners for the same event', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    emitter.on('error', h1);
    emitter.on('error', h2);
    emitter.emit('error', {
      message: 'Something went wrong',
      retriable: false,
    });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('does not call listeners for other events', () => {
    const handler = jest.fn();
    emitter.on('success', handler);
    emitter.emit('error', { message: 'oops', retriable: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('removes a listener via off()', () => {
    const handler = jest.fn();
    emitter.on('success', handler);
    emitter.off('success', handler);
    emitter.emit('success', undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it('removes a listener via the cleanup function returned by on()', () => {
    const handler = jest.fn();
    const cleanup = emitter.on('success', handler);
    cleanup();
    emitter.emit('success', undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not throw when emitting an event with no listeners', () => {
    expect(() => emitter.emit('success', undefined)).not.toThrow();
  });

  it('isolates errors thrown inside one listener from others', () => {
    const badHandler = jest.fn().mockImplementation(() => {
      throw new Error('listener error');
    });
    const goodHandler = jest.fn();

    emitter.on('success', badHandler);
    emitter.on('success', goodHandler);

    // Should not throw to the caller
    expect(() => emitter.emit('success', undefined)).not.toThrow();
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  it('removeAllListeners() prevents all future emissions', () => {
    const handler = jest.fn();
    emitter.on('success', handler);
    emitter.on('error', handler);
    emitter.removeAllListeners();
    emitter.emit('success', undefined);
    emitter.emit('error', { message: 'x', retriable: false });
    expect(handler).not.toHaveBeenCalled();
  });
});
