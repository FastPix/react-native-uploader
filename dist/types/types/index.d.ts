/**
 * `__DEV__` is injected by Metro bundler at build time.
 * Declared here so TypeScript knows about it without needing @types/react-native
 * as a direct dependency of the SDK.
 */
declare global {
    const __DEV__: boolean | undefined;
}
/**
 * Deterministic states of a single upload session.
 * Mirrors the FSM in Section 6 of the design document.
 */
export type UploadState = 'IDLE' | 'STARTED' | 'UPLOADING' | 'PAUSED' | 'RESUMED' | 'FAILED' | 'COMPLETED';
/** All events the SDK can emit to the host application. */
export type UploadEventName = 'started' | 'progress' | 'chunkAttempt' | 'chunkAttemptFailure' | 'chunkSuccess' | 'success' | 'error' | 'pause' | 'resume' | 'offline' | 'online' | 'stateChange';
/** Strongly-typed payload for every event. */
export interface UploadEventPayloads {
    /** Fired once when the upload session is initialised. */
    started: {
        fileSize: number;
        endpoint: string;
    };
    /** Fired after every successfully uploaded chunk with cumulative counts. */
    progress: {
        bytesUploaded: number;
        bytesTotal: number;
        percentage: number;
    };
    /** Fired at the start of every chunk upload attempt, including retries. */
    chunkAttempt: {
        chunkIndex: number;
        attemptNumber: number;
    };
    /** Fired when a chunk attempt fails and will be retried. */
    chunkAttemptFailure: {
        chunkIndex: number;
        attemptNumber: number;
        error: Error;
    };
    /** Fired when a chunk is fully acknowledged by the server. */
    chunkSuccess: {
        chunkIndex: number;
        offset: number;
    };
    /** Fired when every chunk has been acknowledged — upload is complete. */
    success: undefined;
    /** Fired on any non-recoverable error. */
    error: {
        message: string;
        code?: string;
        retriable: boolean;
    };
    /** Fired when the upload is paused (user-initiated or network-triggered). */
    pause: {
        reason: 'user' | 'network';
    };
    /** Fired when a paused upload resumes. */
    resume: {
        fromOffset: number;
    };
    /** Fired when the device loses internet connectivity. */
    offline: undefined;
    /** Fired when the device regains internet connectivity. */
    online: undefined;
    /**
     * Phase 3: Fired on every FSM state transition.
     * Useful for building custom progress UIs without polling `.state`.
     */
    stateChange: {
        from: UploadState;
        to: UploadState;
    };
}
export type UploadEventCallback<T extends UploadEventName> = (payload: UploadEventPayloads[T]) => void;
/** Options accepted by the FastPixUpload constructor. */
export interface FastPixUploadOptions {
    /**
     * The FastPix resumable upload signed URL.
     * Alternatively, provide an async factory function that returns the URL —
     * useful when tokens are short-lived and need refreshing on resume.
     */
    endpoint: string | (() => Promise<string>);
    /**
     * Local file path: a `file://` URI or absolute path from a file picker
     * (e.g. react-native-document-picker, expo-image-picker).
     */
    fileUri: string;
    /**
     * Size of each chunk in **KB**.
     * Minimum: 5120 KB (5 MB). Default: 5120 KB.
     */
    chunkSize?: number;
    /**
     * Maximum retry attempts per failed chunk before the upload fails.
     * Default: 5.
     */
    maxRetries?: number;
    /**
     * Initial retry delay in milliseconds.
     * Retries use exponential back-off: delay × 2^(attempt-1).
     * Default: 1000 ms.
     */
    retryDelay?: number;
    /**
     * When true, the SDK automatically pauses the upload if the device goes
     * offline and resumes when connectivity is restored.
     * Default: true.
     */
    autoHandleNetworkEvents?: boolean;
}
/** Internal representation of a single file chunk. */
export interface ChunkMeta {
    /** Zero-based position of this chunk in the file. */
    index: number;
    /** Byte offset (inclusive) where this chunk starts. */
    start: number;
    /** Byte offset (exclusive) where this chunk ends. */
    end: number;
    /** Total file size in bytes — needed for the Content-Range header. */
    totalSize: number;
}
/** A point-in-time view of upload progress, suitable for UI data-binding. */
export interface UploadProgressSnapshot {
    state: UploadState;
    bytesUploaded: number;
    bytesTotal: number;
    percentage: number;
    currentChunkIndex: number;
}
//# sourceMappingURL=index.d.ts.map