# React Native Upload SDK Example

This example application demonstrates how to integrate and use the **@fastpix/react-native-uploads** SDK.

## Features

* Pick video from device
* Upload using FastPix Upload SDK
* Real-time upload progress
* Pause / Resume upload
* Abort upload
* Automatic retry
* Network disconnect / reconnect handling
* Event log viewer

---

## Prerequisites

* Node.js 20+
* React Native development environment
* Android Studio (Android)
* Xcode 16+ (iOS)
* CocoaPods

---

## Install

```bash
npm install
```

### iOS

```bash
cd ios
pod install
cd ..
```

---

## Run the application

### Android

```bash
npm run android
```

### iOS

```bash
npm run ios
```

---

## Configure Upload Endpoint

The example app requires a valid FastPix signed upload URL.

Update the API configuration with your credentials or backend endpoint before starting an upload.

---


## What the Example Demonstrates

* SDK initialization
* Upload lifecycle
* Upload events
* Progress tracking
* Pause / Resume
* Retry behavior
* Error handling

---

## Notes

* The example is intended only for demonstrating SDK usage.
* Do not use the example API credentials in production.
* Replace the upload endpoint with your own backend-generated FastPix signed URL.
