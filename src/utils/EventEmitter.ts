import type {
  UploadEventName,
  UploadEventCallback,
  UploadEventPayloads,
} from '../types';

/**
 * Lightweight, strongly-typed event emitter.
 *
 * Replaces Node's EventEmitter (not available in React Native's Hermes runtime)
 * and the browser's EventTarget (unavailable in native contexts).
 *
 * Usage:
 *   emitter.on('progress', ({ bytesUploaded, bytesTotal }) => { ... });
 *   emitter.emit('progress', { bytesUploaded: 1024, bytesTotal: 4096, percentage: 25 });
 *   emitter.off('progress', handler);
 */
export class TypedEventEmitter {
  // Map from event name → set of registered callbacks
  private readonly _listeners: Partial<{
    [K in UploadEventName]: Set<UploadEventCallback<K>>;
  }> = {};

  /**
   * Subscribe to an upload lifecycle event.
   *
   * @returns A cleanup function that removes the listener when called –
   *          useful inside React `useEffect` hooks.
   */
  on<K extends UploadEventName>(
    event: K,
    callback: UploadEventCallback<K>,
  ): () => void {
    if (!this._listeners[event]) {
      // Cast required because TypeScript cannot narrow the generic K inside
      // a Partial mapped type without an explicit cast.
      (this._listeners as Record<K, Set<UploadEventCallback<K>>>)[event] =
        new Set();
    }

    (
      this._listeners as Record<K, Set<UploadEventCallback<K>>>
    )[event].add(callback);

    return () => this.off(event, callback);
  }

  /** Remove a previously registered listener. */
  off<K extends UploadEventName>(
    event: K,
    callback: UploadEventCallback<K>,
  ): void {
    const set = (
      this._listeners as Record<K, Set<UploadEventCallback<K>> | undefined>
    )[event];
    set?.delete(callback);
  }

  /**
   * Emit an event to all registered listeners.
   * Errors thrown inside listeners are caught and logged so that one bad
   * listener cannot block subsequent ones.
   */
  emit<K extends UploadEventName>(
    event: K,
    payload: UploadEventPayloads[K],
  ): void {
    const set = (
      this._listeners as Record<K, Set<UploadEventCallback<K>> | undefined>
    )[event];

    if (!set || set.size === 0) {
      return;
    }

    set.forEach((callback) => {
      try {
        callback(payload);
      } catch (err) {
        console.warn(
          `[FastPix] Uncaught error in "${event}" listener:`,
          err,
        );
      }
    });
  }

  /** Remove all listeners – called by `abort()` to prevent memory leaks. */
  removeAllListeners(): void {
    for (const key of Object.keys(this._listeners) as UploadEventName[]) {
      delete this._listeners[key];
    }
  }
}
