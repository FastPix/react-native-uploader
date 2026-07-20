# Changelog

## [0.1.0] - 2026-07-02

Initial release of the FastPix React Native Uploads SDK — reliable, resumable,
chunked uploads for large files on Android and iOS.

### Added

- **`FastPixUpload`** core class with a full upload state machine
  (`IDLE → STARTED → UPLOADING → PAUSED/RESUMED → COMPLETED/FAILED`).
- **Chunked uploads** with a configurable chunk size (5 MB–500 MB).
- **Pause / resume** support that re-syncs the server-confirmed offset before
  continuing, so no bytes are lost or re-sent.
- **Network recovery** — automatic pause on connectivity loss and resume on
  reconnect via `@react-native-community/netinfo`.
- **Wi-Fi ↔ cellular transport-switch detection** — restarts the in-flight
  chunk from the server offset when the socket dies without an offline/online
  cycle.
- **Automatic retries** per chunk with configurable exponential back-off
  (`maxRetries`, `retryDelay`).
- **Real-time progress** tracking with continuous byte/percentage updates.
- **File-size validation** via the optional `maxFileSize` limit (in KB).
- **Endpoint factory** support — `endpoint` accepts a `() => Promise<string>`
  for short-lived signed URLs, resolved once at `start()`.
- **Lifecycle events**: `started`, `progress`, `stateChange`, `chunkAttempt`,
  `chunkAttemptFailure`, `chunkSuccess`, `success`, `error`, `pause`, `resume`,
  `abort`, `offline`, `online`.
- **Control methods**: `start()`, `pause()`, `resume()`, `abort()`, plus
  `on()`/`off()` subscription and `state`, `progress`, and `stateHistory`
  getters.
- **`enableLogs`** option for SDK-internal debug logging (with URL/path masking).
- Example React Native app under `test-example/` demonstrating picking, upload,
  progress, pause/resume/abort, retries, and network recovery.
- Jest test suite covering the core engine, chunking, network monitor, event
  emitter, and validation, with coverage measured in CI.

### Changed

- `maxFileSize` is now specified in **KB** instead of bytes.
- Removed the `autoHandleNetworkEvents` client option; network handling is
  managed internally.

### Fixed

- Retry-count accounting, network-switching, and post-upload UI cleanup.
- Chunk-size validation boundaries.
- Parallel-chunk uploading race that could corrupt progress.
- `abort()` now emits a `0%` progress snapshot before the `abort` event.
- `IDLE → IDLE` transition on `abort()` and the abort callback.

[Unreleased]: https://github.com/FastPix/react-native-uploader/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/FastPix/react-native-uploader/releases/tag/v0.1.0
