import type { UploadEventName, UploadEventCallback, UploadEventPayloads } from '../types';
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
export declare class TypedEventEmitter {
    private readonly _listeners;
    /**
     * Subscribe to an upload lifecycle event.
     *
     * @returns A cleanup function that removes the listener when called –
     *          useful inside React `useEffect` hooks.
     */
    on<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): () => void;
    /** Remove a previously registered listener. */
    off<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): void;
    /**
     * Emit an event to all registered listeners.
     * Errors thrown inside listeners are caught and logged so that one bad
     * listener cannot block subsequent ones.
     */
    emit<K extends UploadEventName>(event: K, payload: UploadEventPayloads[K]): void;
    /** Remove all listeners – called by `abort()` to prevent memory leaks. */
    removeAllListeners(): void;
}
//# sourceMappingURL=EventEmitter.d.ts.map