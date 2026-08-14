# FastPix React Native Uploads — Expo example

A minimal **Expo** app that uploads a video to FastPix with
[`@fastpix/react-native-uploads`](https://github.com/FastPix/react-native-uploader).
Pick a video, watch the progress bar, pause and resume — that's the whole app.

This is one of two examples in this repo:

- [`example/react-native`](../react-native) — the full React Native CLI example (logs, chunk stats, configurable options).
- **`example/expo`** (this app) — a small Expo app showing the smallest useful integration.

> **Heads up:** the Uploads SDK depends on native modules
> (`react-native-blob-util`, `@react-native-community/netinfo`), so this app
> **does not run in Expo Go**. You run it as an [Expo development
> build](https://docs.expo.dev/develop/development-builds/introduction/) with
> `npx expo run:ios` / `npx expo run:android`. Everything below assumes that.

---

## What it shows

- Picking a video with `expo-image-picker`
- Getting a signed upload URL from a backend (credentials never touch the app)
- Uploading with `FastPixUpload` — chunked, resumable
- A progress bar, and working **Pause** / **Resume**

---

## Prerequisites

- Node.js 20.19+ (the backend uses `process.loadEnvFile`)
- Xcode 16+ and CocoaPods (iOS), and/or Android Studio (Android)
- A FastPix account with an **Access Token ID** and **Secret Key**
  ([dashboard](https://dashboard.fastpix.com))

---

## 1. Install

This Expo example installs on its own (it is **not** an npm workspace — Expo
pins its own React Native version, which differs from the CLI example's). First
build the SDK once at the repo root, then install this app:

```bash
# from the repo root (react-native-uploader/)
npm install          # installs + builds the SDK (and the CLI example)

# then this app
cd example/expo
npm install
```

The app links the SDK via `file:../..`; `metro.config.js` forces a single copy
of React / React Native so the linked SDK doesn't pull in a second one.

> If you change the SDK source in `src/`, rebuild it (`npm run build` from the
> repo root) so this example picks up the change.

---

## 2. Start the backend

The app never holds your Secret Key. A tiny backend mints the signed upload URL.

```bash
cd example/expo/backend
npm install
cp .env.example .env      # then edit .env with your FastPix credentials
npm start
```

You should see `Upload backend listening on http://localhost:8787`. Leave it
running. (You can also pass creds inline instead of a `.env` file:
`FASTPIX_USERNAME=... FASTPIX_PASSWORD=... npm start`.)

### Point the app at the backend

`App.tsx` has one constant near the top:

```ts
const CREATE_UPLOAD_ENDPOINT = "http://localhost:8787/uploads";
```

- **iOS Simulator:** `http://localhost:8787/uploads` works as-is.
- **Android emulator:** use `http://10.0.2.2:8787/uploads` (the emulator's alias for your machine).
- **Physical device:** use your computer's LAN IP, e.g. `http://192.168.1.20:8787/uploads`, and make sure the phone is on the same Wi-Fi.

---

## 3. Run the app (development build)

From this folder:

```bash
# iOS
npx expo run:ios

# Android
npx expo run:android
```

The first run compiles the native app (a few minutes) and installs it on the
simulator/emulator or a connected device, then starts Metro. Subsequent JS
edits hot-reload; you only rebuild when native dependencies change.

Tap **Pick a video to upload**, choose a clip, and watch it upload. Use
**Pause** / **Resume** to control it mid-flight.

---

## How the code works

`App.tsx` is the whole app. The flow:

1. **Pick** — `ImagePicker.launchImageLibraryAsync({ mediaTypes: "videos" })` returns a `file://` URI.
2. **Get a URL** — `createUploadUrl()` `POST`s to your backend and returns the signed `uploadUrl`. It's passed to the SDK as a function, so a fresh URL is minted per upload.
3. **Upload** — `new FastPixUpload({ endpoint, fileUri, chunkSize })`, then subscribe to events and call `start()`:

   ```ts
   const upload = new FastPixUpload({
     endpoint: createUploadUrl,        // async () => string
     fileUri: asset.uri,               // file:// URI from the picker
     chunkSize: 5 * 1024,              // 5 MB, in KB (multiple of 256 KB)
   });
   upload.on("progress", ({ percentage }) => setPercentage(percentage));
   upload.on("success", () => setStatus("success"));
   upload.on("error", ({ message }) => setStatus("error"));
   await upload.start();
   ```

4. **Pause / Resume** — keep the instance in a ref and call `upload.pause()` / `upload.resume()`.

The backend (`backend/server.js`) `POST`s to the FastPix direct-upload endpoint
with Basic auth and returns `{ uploadUrl, uploadId }`.

---

## Troubleshooting

**`Your JavaScript code tried to access a native module that doesn't exist.`**
You're running in Expo Go. The Uploads SDK needs native modules — use a
development build (`npx expo run:ios` / `run:android`).

**`Could not create an upload URL` / the upload fails right away.**
The app can't reach the backend. Check the backend is running and that
`CREATE_UPLOAD_ENDPOINT` matches your setup (`localhost` on iOS Simulator,
`10.0.2.2` on Android emulator, LAN IP on a device).

**Every chunk fails with `HTTP 400`.**
Your backend is sending `X-Client-Type: web-browser`. That header is for browser
uploaders; the React Native uploader `PUT`s chunks directly and needs the plain
device upload URL you get by omitting it (this backend already omits it).

**A chunk fails with `HTTP 400` only for larger files.**
`chunkSize` must be a multiple of **256 KB**. `5 * 1024` (5 MB) is fine; keep any
custom value 256 KB-aligned.

**The picker never opens on iOS.**
The photo-library permission string comes from the `expo-image-picker` config
plugin in `app.json`. If you removed it, re-add it and rebuild.

---

## Learn more

- [Uploads SDK README](../../README.md)
- [FastPix documentation](https://docs.fastpix.io)
