// Minimal backend for the Expo uploader example.
//
// It creates a FastPix "direct upload" URL using your Access Token + Secret
// Key, and returns it to the app. Credentials must live here on the server,
// never in the mobile app.
//
// Run:
//   cd example/expo/backend
//   npm install
//   FASTPIX_USERNAME=<access-token-id> FASTPIX_PASSWORD=<secret-key> npm start
import express from "express";

try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // No .env file
}

const FASTPIX_USERNAME = (process.env.FASTPIX_USERNAME ?? "").trim(); // Access Token ID
const FASTPIX_PASSWORD = (process.env.FASTPIX_PASSWORD ?? "").trim(); // Secret Key

if (!FASTPIX_USERNAME || !FASTPIX_PASSWORD) {
  console.error(
    "Set FASTPIX_USERNAME (access token id) and FASTPIX_PASSWORD (secret key).",
  );
  process.exit(1);
}

const UPLOAD_ENDPOINT =
  process.env.FASTPIX_UPLOAD_ENDPOINT ??
  "https://api.fastpix.com/v1/on-demand/upload";
const AUTH = Buffer.from(`${FASTPIX_USERNAME}:${FASTPIX_PASSWORD}`).toString(
  "base64",
);

const app = express();

app.post("/uploads", async (_req, res) => {
  try {
    const response = await fetch(UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${AUTH}`,
      },
      body: JSON.stringify({
        corsOrigin: "*",
        pushMediaSettings: { accessPolicy: "public" },
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      console.error("FastPix error:", response.status, JSON.stringify(body?.error ?? body));
      return res
        .status(502)
        .json({ error: body?.error?.message ?? `status ${response.status}` });
    }

    const data = body.data ?? body;
    console.log("Created upload:", data.uploadId);
    res.json({ uploadUrl: data.url, uploadId: data.uploadId });
  } catch (err) {
    console.error("Upload URL error:", err?.message ?? err);
    res.status(500).json({ error: "could not create upload url" });
  }
});

// Bind 0.0.0.0 so the simulator/emulator and a device on your LAN can reach it.
app.listen(8787, "0.0.0.0", () =>
  console.log("Upload backend listening on http://localhost:8787"),
);
