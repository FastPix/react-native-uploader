import type { UploadEventName, UploadEventCallback, UploadEventPayloads } from '../types';
export declare class TypedEventEmitter {
    private readonly _listeners;
    on<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): () => void;
    off<K extends UploadEventName>(event: K, callback: UploadEventCallback<K>): void;
    emit<K extends UploadEventName>(event: K, payload: UploadEventPayloads[K]): void;
    removeAllListeners(): void;
}
//# sourceMappingURL=EventEmitter.d.ts.map