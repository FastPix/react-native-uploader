---
name: Question/Support
about: Ask questions or get help with the FastPix React Native Uploads SDK
title: '[QUESTION] '
labels: ['question', 'needs-triage']
assignees: ''
---

# Question/Support

Thank you for reaching out! We're here to help you with the FastPix React Native Uploads SDK. To get faster and more accurate help, please provide the following information:

## Question Type
- [ ] How to use a specific feature
- [ ] Integration help
- [ ] Configuration question
- [ ] Signed URL / backend setup
- [ ] Pause, resume, or network recovery behaviour
- [ ] Performance question
- [ ] Troubleshooting help
- [ ] Other: _______________

## Question
**What would you like to know?**

<!-- Provide a clear and specific question about the Uploads SDK -->

## What You've Tried
**What have you already attempted to solve this?**

```javascript
import { FastPixUpload } from '@fastpix/react-native-uploads';

const upload = new FastPixUpload({
  endpoint: '<SIGNED_UPLOAD_URL>',
  fileUri: 'file:///path/to/video.mp4',
  enableLogs: true,
});

// Your attempted code here
await upload.start();
```

> **Never paste your Access Token or Secret Key here.** Redact signed URLs too.

## Current Setup
**Describe your current setup:**
- How you obtain the signed URL (backend service, endpoint factory function, hardcoded for testing)
- How you obtain the `fileUri` (image picker, document picker, camera, file system)
- Whether you are using the New Architecture (Fabric) or the Old Architecture

## Environment
- **SDK Version**: [e.g., 0.1.0]
- **React Native**: [e.g., 0.85.0]
- **Platform**: [e.g., iOS 17.4 / Android 14]
- **Device**: [e.g., iPhone 15 Pro, Pixel 8, Simulator/Emulator]
- **JS Engine**: [Hermes / JSC]
- **Node/npm**: [e.g., Node 20, npm 10]
- **Package manager**: [npm / yarn / pnpm]

## Configuration
**Current upload configuration:**

```javascript
{
  chunkSize: 5120,    // KB — must be >= 5120 and divisible by 256
  maxRetries: 3,
  retryDelay: 1000,
  maxFileSize: 0,     // KB — 0 means no limit
  enableLogs: true,
}
```

## Expected Outcome
**What are you trying to achieve?**

<!-- Example: resume across app restarts, tune chunk size for slow networks, track per-chunk retries, handle WiFi ↔ cellular switches -->

## Error Messages (if any)
```
<!-- Paste any [FastPix:*] logs or unexpected behaviour -->
```

## Additional Context

### Use Case
**What are you building?**
- [ ] Consumer video app (reels, social, UGC)
- [ ] Enterprise / internal tooling
- [ ] Video streaming product
- [ ] Other: _______________

### Timeline
**When do you need this resolved?**
- [ ] ASAP (blocking development)
- [ ] This week
- [ ] This month
- [ ] No rush

### Resources Checked
**What resources have you already checked?**
- [ ] README.md
- [ ] API Reference / Configuration Parameters
- [ ] Lifecycle Events Reference
- [ ] Troubleshooting section
- [ ] Example app (`example/`)
- [ ] GitHub Issues
- [ ] Other: _______________

## Priority
Please indicate the urgency:
- [ ] Critical (Blocking production deployment)
- [ ] High (Blocking development)
- [ ] Medium (Would like to know soon)
- [ ] Low (Just curious)

## Checklist
Before submitting, please ensure:
- [ ] I have provided a clear question
- [ ] I have described what I've tried
- [ ] I have included my current setup and environment
- [ ] I have checked existing documentation
- [ ] I have provided sufficient context

---

**We'll do our best to help you get unstuck!**

**Helpful Resources:**
- [FastPix Documentation](https://fastpix.com/docs/video-on-demand-api/upload-and-import-videos/direct-upload-video-media)
- [React Native Uploads README](https://github.com/FastPix/react-native-uploader#readme)
- [GitHub Issues](https://github.com/FastPix/react-native-uploader/issues)
