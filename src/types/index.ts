declare global {
  const __DEV__: boolean | undefined;
}

// ─── Upload State Machine ──────────────────────────────────────────────────────

export type UploadState =
  | 'IDLE'
  | 'STARTED'
  | 'UPLOADING'
  | 'PAUSED'
  | 'RESUMED'
  | 'FAILED'
  | 'COMPLETED';

// ─── Event System ─────────────────────────────────────────────────────────────

/** All events the SDK can emit to the host application. */
export type UploadEventName =
  | 'started'
  | 'progress'
  | 'chunkAttempt'
  | 'chunkAttemptFailure'
  | 'chunkSuccess'
  | 'success'
  | 'error'
  | 'pause'
  | 'resume'
  | 'offline'
  | 'online'
  | 'stateChange'
  | 'abort';

/** Strongly-typed payload for every event. */
export interface UploadEventPayloads {
  /** Fired once when the upload session is initialised. */
  started: { fileSize: number; endpoint: string };

  /** Fired after every successfully uploaded chunk with cumulative counts. */
  progress: { bytesUploaded: number; bytesTotal: number; percentage: number };

  /** Fired at the start of every chunk upload attempt, including retries. */
  chunkAttempt: { chunkIndex: number; attemptNumber: number , totalChunkNumbers: number};

  /** Fired when a chunk attempt fails and will be retried. */
  chunkAttemptFailure: { chunkIndex: number; attemptNumber: number; error: Error };

  /** Fired when a chunk is fully acknowledged by the server. */
  chunkSuccess: { chunkIndex: number; offset: number };

  /** Fired when every chunk has been acknowledged — upload is complete. */
  success: undefined;

  /** Fired on any non-recoverable error. */
  error: { message: string; code?: string; retriable: boolean };

  /** Fired when the upload is paused (user-initiated or network-triggered). */
  pause: { reason: 'user' | 'network' };

  /** Fired when a paused upload resumes. */
  resume: { fromOffset: number };

  /** Fired when the device loses internet connectivity. */
  offline: undefined;

  /** Fired when the device regains internet connectivity. */
  online: undefined;

    /**
   * Fired when abort() is called and the upload is successfully cancelled.
   */

  abort: undefined;

  stateChange: { from: UploadState; to: UploadState };
}

export type UploadEventCallback<T extends UploadEventName> = (
  payload: UploadEventPayloads[T],
) => void;

// ─── Configuration ────────────────────────────────────────────────────────────

/** Options accepted by the FastPixUpload constructor. */
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

// ─── Chunk Metadata ───────────────────────────────────────────────────────────

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

// ─── Progress Snapshot ────────────────────────────────────────────────────────

/** A point-in-time view of upload progress, suitable for UI data-binding. */
export interface UploadProgressSnapshot {
  state: UploadState;
  bytesUploaded: number;
  bytesTotal: number;
  percentage: number;
  currentChunkIndex: number;
}
