import type {
  UploadEventName,
  UploadEventCallback,
  UploadEventPayloads,
} from '../types';

export class TypedEventEmitter {
  // Map from event name → set of registered callbacks
  private readonly _listeners: Partial<{
    [K in UploadEventName]: Set<UploadEventCallback<K>>;
  }> = {};

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
