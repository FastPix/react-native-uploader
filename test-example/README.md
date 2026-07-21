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

This example is an **npm workspace** of the SDK repo, so dependencies are hoisted to the
repository root. Install from the **repo root**, not from this folder:

```bash
cd ..          # repository root
npm install    # installs the SDK + this example, and builds the SDK
```

After this, most packages live in `<repo-root>/node_modules`, and `test-example/node_modules`
will look almost empty. That is expected — the Android and Metro configs resolve packages
through Node, so they find them wherever npm hoisted them.

> **`node` must be on your `PATH`.** The Android build resolves React Native's Gradle plugin by
> calling `node --print "require.resolve(...)"`. This works from a terminal. If you build from
> **Android Studio launched via Finder/Dock** and manage Node with `nvm`, Android Studio won't
> inherit your shell `PATH` and the build fails with
> `Included build '.../@react-native/gradle-plugin' does not exist`.
> Either launch Android Studio from a terminal (`open -a "Android Studio" .`) or symlink node:
> `sudo ln -s "$(which node)" /usr/local/bin/node`.

### iOS

```bash
cd ios
pod install
cd ..
```

---

## Configure credentials (required before uploading)

The example reads its FastPix credentials from a `.env` file via
[`react-native-dotenv`](https://github.com/goatandsheep/react-native-dotenv). **There is no `.env`
in the repo** — create one from the template:

```bash
cp .env.example .env
```

Then fill in all three values (names must match exactly — they are imported in
[`src/Constants/ApiKeys.ts`](src/Constants/ApiKeys.ts)):

```bash
Base_Api_Url = https://api.fastpix.io/v1/on-demand
Access_Token_Id = <your FastPix access token id>
Secret_Key = <your FastPix secret key>
```

* `Base_Api_Url` is the **base** URL only — `ApiService` appends `/upload` itself.
* Get the token id / secret from the [FastPix Dashboard](https://dashboard.fastpix.com/).

Values are inlined into the bundle at **build time**, so after creating or editing `.env` you must
restart Metro with a cleared cache:

```bash
npm start -- --reset-cache
```

> If you skip this step the app builds and runs normally, but every credential is `undefined`, the
> request goes to `undefined/upload`, and the upload fails with a misleading
> **`CreateUploadError`** network message.

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

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `Included build '.../node_modules/@react-native/gradle-plugin' does not exist` | Ran `npm install` inside `test-example/` only, or `node` is not on the `PATH` of the process running Gradle (typical for Android Studio + `nvm`). | Run `npm install` from the repo root; launch Android Studio from a terminal or symlink node. |
| `CreateUploadError` / network error while online | No `.env` file, or Metro cached the old (empty) values. | `cp .env.example .env`, fill all three values, then `npm start -- --reset-cache`. |
| `HTTP 401` from the upload API | Wrong `Access_Token_Id` / `Secret_Key`. | Regenerate credentials in the FastPix Dashboard. |
| `HTTP 404` from the upload API | `Base_Api_Url` includes a path such as `/upload`. | Set the base URL only: `https://api.fastpix.io/v1/on-demand`. |

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
