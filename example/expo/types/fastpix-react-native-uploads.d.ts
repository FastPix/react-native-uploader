declare module "@fastpix/react-native-uploads" {
  export type UploadState =
    | "IDLE"
    | "STARTED"
    | "UPLOADING"
    | "PAUSED"
    | "RESUMED"
    | "FAILED"
    | "COMPLETED";

  export interface FastPixUploadOptions {
    endpoint: string | (() => Promise<string>);
    fileUri: string;
    chunkSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    maxFileSize?: number;
    enableLogs?: boolean;
  }

  export interface UploadEventPayloads {
    started: { fileSize: number; endpoint: string };
    progress: { bytesUploaded: number; bytesTotal: number; percentage: number };
    success: undefined;
    error: { message: string; code?: string; retriable: boolean };
    pause: { reason: "user" | "network" };
    resume: { fromOffset: number };
    stateChange: { from: UploadState; to: UploadState };
  }

  export class FastPixUpload {
    constructor(options: FastPixUploadOptions);
    on<K extends keyof UploadEventPayloads>(
      event: K,
      callback: (payload: UploadEventPayloads[K]) => void,
    ): () => void;
    off<K extends keyof UploadEventPayloads>(
      event: K,
      callback: (payload: UploadEventPayloads[K]) => void,
    ): void;
    start(): Promise<void>;
    pause(): void;
    resume(): Promise<void>;
    abort(): void;
    readonly state: UploadState;
  }
}
