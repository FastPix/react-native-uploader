---
name: Bug Report
about: Report an issue related to the FastPix React Native Uploads SDK
title: '[BUG] '
labels: bug
assignees: ''
---

# Bug Description
Provide a clear and concise description of the issue you encountered with the FastPix React Native Uploads SDK.

---

# Steps to Reproduce

### 1. **SDK Setup**

Install the FastPix React Native Uploads SDK:

```bash
npm install @fastpix/react-native-uploads
# or
yarn add @fastpix/react-native-uploads
```

This SDK depends on `react-native-blob-util` and `@react-native-community/netinfo`. On iOS, run `pod install` after installing.

### 2. **Example Code to Reproduce**

Provide a minimal reproducible snippet that shows the issue. Example:

```javascript
import { FastPixUpload } from '@fastpix/react-native-uploads';

const upload = new FastPixUpload({
  endpoint: '<SIGNED_UPLOAD_URL>',
  fileUri: 'file:///path/to/video.mp4',
  chunkSize: 5120,   // KB
  maxRetries: 3,
  retryDelay: 1000,
  enableLogs: true,  // please enable when reporting a bug
});

upload.on('progress', ({ percentage }) => console.log(percentage));
upload.on('error', ({ message, code }) => console.log(code, message));

await upload.start();
```

Replace with the exact code where the bug occurs.

> **Never paste your Access Token or Secret Key into this issue.** Signed URLs are short-lived, but redact them anyway.

---

# Expected Behavior
```
<!-- Describe what you expected to happen -->
```

# Actual Behavior
```
<!-- Describe what actually happened -->
```

---

# Environment

- **SDK Version**: [e.g., 0.1.0]
- **React Native**: [e.g., 0.85.0]
- **Platform**: [e.g., iOS 17.4 / Android 14]
- **Device**: [e.g., iPhone 15 Pro, Pixel 8, Android Emulator, iOS Simulator]
- **JS Engine**: [Hermes / JSC]
- **Architecture**: [New Architecture (Fabric) / Old Architecture]
- **Node/npm**: [e.g., Node 20, npm 10]
- **Package manager**: [npm / yarn / pnpm]

---

# Upload Configuration

- **Chunk size**: [e.g., 5120 KB]
- **File size**: [e.g., 250 MB]
- **File source**: [e.g., react-native-image-picker, camera roll, document picker, app sandbox]
- **maxRetries / retryDelay**: [e.g., 3 / 1000]
- **maxFileSize**: [e.g., 0 (no limit)]

---

# Logs / Errors / Console Output

Re-run with `enableLogs: true` and paste the `[FastPix:*]` output here.

```
Paste SDK logs, Metro output, or native crash logs here
```

---

# Additional Context
Add any information that might help, such as:

- Does it reproduce on both iOS and Android, or only one?
- Was the upload paused/resumed, or aborted, before the issue?
- Did the network change mid-upload (offline → online, WiFi ↔ cellular)?
- Was the app backgrounded during the upload?
- Which upload state was active when it failed (`IDLE`/`STARTED`/`UPLOADING`/`PAUSED`/`RESUMED`/`FAILED`/`COMPLETED`)?
- Is the file on local storage, or a cloud-backed URI (iCloud / Google Photos)?

---

# Screenshots / Screen Recording
If applicable, attach screenshots or a short video demonstrating the issue.
