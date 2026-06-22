import { warn } from '../utils/logger';
import type {
  UploadEventName,
  UploadEventCallback,
  UploadEventPayloads,
} from '../types';

export class TypedEventEmitter {
  private readonly _listeners: Partial<{
    [K in UploadEventName]: Set<UploadEventCallback<K>>;
  }> = {};

  on<K extends UploadEventName>(
    event: K,
    callback: UploadEventCallback<K>,
  ): () => void {
    if (!this._listeners[event]) {
           (this._listeners as Record<K, Set<UploadEventCallback<K>>>)[event] =
        new Set();
    }

    (
      this._listeners as Record<K, Set<UploadEventCallback<K>>>
    )[event].add(callback);

    return () => this.off(event, callback);
  }

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
        warn(
          `[FastPix] Uncaught error in "${event}" listener:`,
          err,
        );
      }
    });
  }

  // Remove all listeners – called by `abort()` to prevent memory leaks
  removeAllListeners(): void {
    for (const key of Object.keys(this._listeners) as UploadEventName[]) {
      delete this._listeners[key];
    }
  }
}
