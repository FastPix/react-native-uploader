# React Native Uploads SDK

The FastPix React Native Uploads SDK provides reliable, resumable, and high-performance uploads for large files in React Native applications. It supports chunked uploads, automatic retries, pause and resume, network recovery, and real-time progress tracking on both Android and iOS.

Please note that this SDK is designed to work only with FastPix and is not a general purpose uploads SDK.

## Features

* **Chunked Uploads** – Upload large files in configurable chunks (5 MB–500 MB).
* **Resumable Uploads** – Pause and resume uploads without re-uploading completed chunks.
* **Network Recovery** – Automatically pause and resume uploads when connectivity changes.
* **Real-time Progress** – Track upload progress with smooth, continuous updates.
* **Automatic Retries** – Recover from temporary failures with configurable exponential backoff.
* **File Size Validation** – Optionally enforce a maximum file size before uploading.
* **Flexible File URI Support** – Accepts `file://` URIs and plain filesystem paths, with automatic URL-decoding of percent-encoded paths.
* **Lifecycle Events** – Listen to upload progress, state changes, and completion events.

## Prerequisites

### Getting started with FastPix

To get started with the SDK, you will need a signed URL.

To make API requests, you'll need a valid **Access Token** and **Secret Key**. See the [Basic Authentication Guide](https://fastpix.com/docs/getting-started/activate-your-account) for details on retrieving these credentials.

Once you have your credentials, use the [Upload media from device](https://fastpix.com/docs/video-on-demand-api/upload-and-import-videos/direct-upload-video-media) API to generate a signed URL for uploading media.

## Platform Support

| Platform     | Minimum version    |
| ------------ | ------------------ |
| Android      | API 21 (Android 5.0) |
| iOS          | iOS 13.0           |
| React Native | 0.70+              |

## Installation

To install the SDK, you can use NPM, Yarn, or your preferred package manager:

```bash
npm install @fastpix/react-native-uploads
# or
yarn add @fastpix/react-native-uploads
```

The SDK bundles its runtime dependencies (`@react-native-community/netinfo`, `react-native-blob-util`, and `axios`), so there are no peer dependencies to install manually.

### iOS — install native pods

The bundled native modules auto-link on React Native 0.70+. After installing the package, run:

```bash
cd ios && pod install && cd ..
```

**Android:** No manual linking or extra setup is required — the native modules auto-link.

## Basic Usage

### Import

```javascript
import { FastPixUpload } from "@fastpix/react-native-uploads";
```

### Integration

```javascript
const upload = new FastPixUpload({
  endpoint: "https://storage.googleapis.com/...your-signed-url...", // Replace with the signed URL.
  fileUri: asset.uri, // file:// URI from your image picker.
  chunkSize: 5 * 1024, // Minimum allowed chunk size is 5120KB (5MB).

  // Additional optional parameters can be specified here as needed
});

await upload.start();
```

## Monitor Upload Lifecycle

Subscribe to upload lifecycle events using `upload.on(event, handler)`. Each subscription returns a cleanup function, making it easy to use with React's `useEffect`.

```javascript
// Upload started
upload.on("started", ({ fileSize }) => {
  console.log(`Upload started (${fileSize} bytes)`);
});

// Upload progress
upload.on("progress", ({ percentage, bytesUploaded, bytesTotal }) => {
  console.log(`${percentage}% (${bytesUploaded}/${bytesTotal})`);
});

// Upload state changes
upload.on("stateChange", ({ from, to }) => {
  console.log(`${from} → ${to}`);
});

// Chunk lifecycle
upload.on("chunkAttempt", ({ chunkIndex, attemptNumber, totalChunkNumbers }) => {
  console.log(`Chunk ${chunkIndex}/${totalChunkNumbers} - Attempt ${attemptNumber}`);
});

upload.on("chunkAttemptFailure", ({ chunkIndex, attemptNumber, error }) => {
  console.warn(`Chunk ${chunkIndex} failed (Attempt ${attemptNumber}): ${error.message}`);
});

upload.on("chunkSuccess", ({ chunkIndex }) => {
  console.log(`Chunk ${chunkIndex} uploaded`);
});

// Upload completed
upload.on("success", () => {
  console.log("Upload completed successfully");
});

// Upload failed
upload.on("error", ({ message }) => {
  console.error(message);
});

// Upload paused/resumed
upload.on("pause", ({ reason }) => {
  console.log(`Paused: ${reason}`);
});

upload.on("resume", ({ fromOffset }) => {
  console.log(`Resumed from offset ${fromOffset}`);
});

// Upload aborted
upload.on("abort", () => {
  console.log("Upload aborted");
});

// Network status
upload.on("offline", () => {
  console.log("Network offline");
});

upload.on("online", () => {
  console.log("Network online");
});
```

### Supported Events

| Event                 | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `started`             | Fired when the upload starts.                                |
| `progress`            | Reports upload progress, uploaded bytes, and total bytes.    |
| `stateChange`         | Fired whenever the upload state changes.                     |
| `chunkAttempt`        | Fired before each chunk upload attempt.                      |
| `chunkAttemptFailure` | Fired when a chunk upload attempt fails and will be retried. |
| `chunkSuccess`        | Fired after a chunk is uploaded successfully.                |
| `success`             | Fired when the upload completes successfully.                |
| `error`               | Fired when the upload fails with a non-recoverable error.    |
| `pause`               | Fired when the upload is paused.                             |
| `resume`              | Fired when the upload resumes.                               |
| `abort`               | Fired when the upload is cancelled.                          |
| `offline`             | Fired when network connectivity is lost.                     |
| `online`              | Fired when network connectivity is restored.                 |


## Managing Uploads

You can control the upload lifecycle with the following methods:

- **Start an Upload:**

  ```javascript
  await upload.start(); // Valid only when state is IDLE
  ```

- **Pause an Upload:**

  ```javascript
  upload.pause(); // Valid only when state is UPLOADING; preserves the last acknowledged offset
  ```

- **Resume an Upload:**

  ```javascript
  await upload.resume(); // Valid only when state is PAUSED; re-syncs the server offset first
  ```

- **Abort an Upload:**

  ```javascript
  upload.abort(); // Permanently cancels and releases all resources; emits `abort` before removing listeners
  ```

## Parameters Accepted

The `FastPixUpload` constructor accepts the following parameters:

| Name                       | Type                                | Required | Description                                                                                                                                       |
| -------------------------- | ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`                 | `string` or `() => Promise<string>` | Required | The signed FastPix upload URL, or an async factory that returns one. The factory is called once at `start()` — useful when tokens are short-lived. |
| `fileUri`                  | `string`                            | Required | Local file path from your file picker. Accepts `file://` URIs, plain paths.         |
| `chunkSize`                | `number` (in KB)                    | Optional | Size of each chunk in kilobytes. Default is `5120` KB (5 MB). **Minimum:** 5120 KB (5 MB), **Maximum:** 512000 KB (500 MB).                    |
| `maxRetries`               | `number`                            | Optional | Maximum retry attempts per failed chunk before the upload fails. Default is `5`.                                                                  |
| `retryDelay`               | `number` (in ms)                    | Optional | Initial delay before the first retry. Each subsequent retry doubles the delay (exponential back-off). Default is `1000`.                          |
| `maxFileSize`              | `number` (in KB)                 | Optional | Maximum allowed file size. `0` means no limit. Files exceeding this fail immediately before any network request. Default is `0`.                  |
| `enableLogs`               | `boolean`                           | Optional | Enable SDK-internal debug logging to the console. Recommended for development; disable in production. Default is `false`.                         |

### Example usage of integrating all parameters

```javascript
import { FastPixUpload } from "@fastpix/react-native-uploads";

const upload = new FastPixUpload({
  endpoint: "https://storage.googleapis.com/...signed-url...", // Signed URL for uploading
  fileUri: "file://...File_Path..." // file:// URI to upload
  chunkSize: 5 * 1024, // default is 5 MB per chunk
  maxRetries: 3, // Retry each failed chunk up to 3 times
  retryDelay: 1000, // Initial 1s delay, doubling each retry
  maxFileSize: 200 * 1024, // 200 MB limit
  enableLogs: false, // Debug logs in development only
});

upload.on("started", ({ fileSize }) => console.log(`Starting ${fileSize} bytes`));
upload.on("progress", ({ percentage }) => console.log(`${percentage}%`));
upload.on("success", () => console.log("Upload complete!"));
upload.on("error", ({ message }) => console.error(message));

await upload.start();

// Control:
// upload.pause();
// await upload.resume();
// upload.abort();
```
## Example App

A complete React Native example application is included in the repository to help you get started quickly.

The example demonstrates:

* Selecting media from the device
* Creating an upload instance
* Tracking upload progress
* Handling upload lifecycle events
* Pause, resume, and abort operations
* Network recovery
* Error handling

Refer to the **`example/`** directory for the complete implementation.

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `File is empty or could not be read` | The `fileUri` points to a missing file, or a `content://` / asset URI the native layer can't `stat`. | Pass a resolved `file://` path or plain filesystem path. Copy picker/asset URIs to a local file first. |
| `File size … exceeds the maximum allowed size` | The file is larger than `maxFileSize` (in **KB**). | Increase `maxFileSize`, or set it to `0` to disable the limit. |
| `chunkSize` validation error | `chunkSize` is outside the allowed range. | Use a value between `5120` KB (5 MB) and `512000` KB (500 MB). |
| Upload never starts / `start() ignored` | `start()` was called while the upload was not in the `IDLE` state. | Only call `start()` from `IDLE`; use `resume()` to continue a paused upload. |
| Upload stalls after switching Wi-Fi ↔ cellular | The in-flight socket died without an offline/online event. | The SDK detects the transport switch and resumes from the server-confirmed offset automatically — no action needed. |
| iOS build fails to find native modules | Pods not installed after adding the package. | Run `cd ios && pod install`. |
| No events firing | Listeners were attached after `abort()`, which removes all listeners. | Re-attach listeners on a new `FastPixUpload` instance after an abort. |

Enable `enableLogs: true` in the constructor to see detailed SDK-internal logs while diagnosing issues (disable in production).

## References

[FastPix Homepage](https://www.fastpix.com/)
[FastPix Dashboard](https://dashboard.fastpix.com/)

## Detailed Usage

For more detailed steps and advanced usage, please refer to the official [FastPix Documentation](https://fastpix.com/docs/upload-videos/upload-videos-from-device#resumable-uploading-of-large-files).
 