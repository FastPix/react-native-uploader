import { TypedEventEmitter } from '../src/utils/EventEmitter';

jest.mock('../utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

import { warn } from '../src/utils/logger';

describe('TypedEventEmitter', () => {
  let emitter: TypedEventEmitter;

  beforeEach(() => {
    emitter = new TypedEventEmitter();
    jest.clearAllMocks();
  });

  describe('on()', () => {
    it('registers a listener and calls it when the event is emitted', () => {
      const cb = jest.fn();
      emitter.on('progress', cb);
      emitter.emit('progress', { bytesUploaded: 100, bytesTotal: 1000, percentage: 10 });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({ bytesUploaded: 100, bytesTotal: 1000, percentage: 10 });
    });

    it('returns an unsubscribe function', () => {
      const cb = jest.fn();
      const unsub = emitter.on('progress', cb);
      unsub();
      emitter.emit('progress', { bytesUploaded: 100, bytesTotal: 1000, percentage: 10 });
      expect(cb).not.toHaveBeenCalled();
    });

    it('allows multiple listeners for the same event', () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      emitter.on('progress', cb1);
      emitter.on('progress', cb2);
      emitter.emit('progress', { bytesUploaded: 0, bytesTotal: 100, percentage: 0 });
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('allows listeners for different events independently', () => {
      const progressCb = jest.fn();
      const errorCb = jest.fn();
      emitter.on('progress', progressCb);
      emitter.on('error', errorCb);

      emitter.emit('progress', { bytesUploaded: 0, bytesTotal: 100, percentage: 0 });
      expect(progressCb).toHaveBeenCalledTimes(1);
      expect(errorCb).not.toHaveBeenCalled();
    });

    it('does not duplicate the same callback reference', () => {
      const cb = jest.fn();
      emitter.on('success', cb);
      emitter.on('success', cb); // same reference
      emitter.emit('success', undefined);
      // Sets deduplicate — called exactly once
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  // ── off() ──────────────────────────────────
  describe('off()', () => {
    it('removes the specified listener', () => {
      const cb = jest.fn();
      emitter.on('error', cb);
      emitter.off('error', cb);
      emitter.emit('error', { message: 'oops', retriable: false, code: 'UPLOAD_FAILED' });
      expect(cb).not.toHaveBeenCalled();
    });

    it('does not throw when removing a listener that was never registered', () => {
      const cb = jest.fn();
      expect(() => emitter.off('success', cb)).not.toThrow();
    });

    it('removes only the specified listener, leaving others intact', () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      emitter.on('success', cb1);
      emitter.on('success', cb2);
      emitter.off('success', cb1);
      emitter.emit('success', undefined);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  // emit() 
  describe('emit()', () => {
    it('does nothing when no listeners are registered for the event', () => {
      expect(() => emitter.emit('success', undefined)).not.toThrow();
    });

    it('passes the correct payload to each listener', () => {
      const cb = jest.fn();
      emitter.on('chunkSuccess', cb);
      emitter.emit('chunkSuccess', { chunkIndex: 2, offset: 10485760 });
      expect(cb).toHaveBeenCalledWith({ chunkIndex: 2, offset: 10485760 });
    });

    it('catches and warns about errors thrown by a listener without stopping other listeners', () => {
      const badCb = jest.fn().mockImplementation(() => {
        throw new Error('listener blew up');
      });
      const goodCb = jest.fn();

      emitter.on('success', badCb);
      emitter.on('success', goodCb);
      emitter.emit('success', undefined);

      expect(badCb).toHaveBeenCalledTimes(1);
      expect(goodCb).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"success" listener:'),
        expect.any(Error),
      );
    });

    it('emits stateChange event with from/to payload', () => {
      const cb = jest.fn();
      emitter.on('stateChange', cb);
      emitter.emit('stateChange', { from: 'IDLE', to: 'STARTED' });
      expect(cb).toHaveBeenCalledWith({ from: 'IDLE', to: 'STARTED' });
    });

    it('emits pause event with reason payload', () => {
      const cb = jest.fn();
      emitter.on('pause', cb);
      emitter.emit('pause', { reason: 'network' });
      expect(cb).toHaveBeenCalledWith({ reason: 'network' });
    });

    it('emits resume event with fromOffset payload', () => {
      const cb = jest.fn();
      emitter.on('resume', cb);
      emitter.emit('resume', { fromOffset: 5242880 });
      expect(cb).toHaveBeenCalledWith({ fromOffset: 5242880 });
    });
  });

  // removeAllListeners() 
  describe('removeAllListeners()', () => {
    it('removes all registered listeners across all events', () => {
      const progressCb = jest.fn();
      const successCb = jest.fn();
      const errorCb = jest.fn();

      emitter.on('progress', progressCb);
      emitter.on('success', successCb);
      emitter.on('error', errorCb);

      emitter.removeAllListeners();

      emitter.emit('progress', { bytesUploaded: 0, bytesTotal: 100, percentage: 0 });
      emitter.emit('success', undefined);
      emitter.emit('error', { message: 'x', retriable: false, code: 'UPLOAD_FAILED' });

      expect(progressCb).not.toHaveBeenCalled();
      expect(successCb).not.toHaveBeenCalled();
      expect(errorCb).not.toHaveBeenCalled();
    });

    it('is safe to call when no listeners are registered', () => {
      expect(() => emitter.removeAllListeners()).not.toThrow();
    });

    it('allows re-registration after removeAllListeners()', () => {
      const cb = jest.fn();
      emitter.on('success', cb);
      emitter.removeAllListeners();
      emitter.on('success', cb);
      emitter.emit('success', undefined);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  // unsubscribe via returned function 
  describe('unsubscribe returned by on()', () => {
    it('is idempotent — calling it multiple times does not throw', () => {
      const cb = jest.fn();
      const unsub = emitter.on('abort', cb);
      unsub();
      expect(() => unsub()).not.toThrow();
    });
  });
});