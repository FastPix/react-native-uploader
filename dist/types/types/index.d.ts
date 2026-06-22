declare global {
    const __DEV__: boolean | undefined;
}
export type UploadState = 'IDLE' | 'STARTED' | 'UPLOADING' | 'PAUSED' | 'RESUMED' | 'FAILED' | 'COMPLETED';
export type UploadEventName = 'started' | 'progress' | 'chunkAttempt' | 'chunkAttemptFailure' | 'chunkSuccess' | 'success' | 'error' | 'pause' | 'resume' | 'offline' | 'online' | 'stateChange' | 'abort';
export interface UploadEventPayloads {
    started: {
        fileSize: number;
        endpoint: string;
    };
    progress: {
        bytesUploaded: number;
        bytesTotal: number;
        percentage: number;
    };
    chunkAttempt: {
        chunkIndex: number;
        attemptNumber: number;
        totalChunkNumbers: number;
    };
    chunkAttemptFailure: {
        chunkIndex: number;
        attemptNumber: number;
        error: Error;
    };
    chunkSuccess: {
        chunkIndex: number;
        offset: number;
    };
    success: undefined;
    error: {
        message: string;
        code?: string;
        retriable: boolean;
    };
    pause: {
        reason: 'user' | 'network';
    };
    resume: {
        fromOffset: number;
    };
    offline: undefined;
    online: undefined;
    abort: undefined;
    stateChange: {
        from: UploadState;
        to: UploadState;
    };
}
export type UploadEventCallback<T extends UploadEventName> = (payload: UploadEventPayloads[T]) => void;
export interface FastPixUploadOptions {
    endpoint: string | (() => Promise<string>);
    fileUri: string;
    chunkSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    maxFileSize?: number;
    autoHandleNetworkEvents?: boolean;
    enableLogs?: boolean;
}
export interface ChunkMeta {
    index: number;
    start: number;
    end: number;
    totalSize: number;
}
export interface UploadProgressSnapshot {
    state: UploadState;
    bytesUploaded: number;
    bytesTotal: number;
    percentage: number;
    currentChunkIndex: number;
}
//# sourceMappingURL=index.d.ts.map