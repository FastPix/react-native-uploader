import { FastPixUpload } from "@fastpix/react-native-uploads";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import { useRef, useState } from "react";
import { Button, Platform, StyleSheet, Text, View } from "react-native";

// Your backend route that creates a FastPix signed upload URL.
// - iOS Simulator: http://localhost:8787 reaches your machine.
// - Android emulator: 10.0.2.2 is the emulator's alias for your machine.
// - Physical device: use your computer's LAN IP, e.g. http://192.168.1.20:8787
const CREATE_UPLOAD_ENDPOINT = Platform.select({
  android: "http://10.0.2.2:8787/uploads",
  default: "http://localhost:8787/uploads",
});

type Status = "idle" | "uploading" | "paused" | "success" | "error";

// The SDK calls this when an upload starts, so a signed URL is minted per
// upload rather than per app launch.
async function createUploadUrl(): Promise<string> {
  const response = await fetch(CREATE_UPLOAD_ENDPOINT, { method: "POST" });
  if (!response.ok) throw new Error("Could not create an upload URL");
  const { uploadUrl } = (await response.json()) as { uploadUrl: string };
  return uploadUrl;
}

export default function App() {
  const uploadRef = useRef<FastPixUpload | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [percentage, setPercentage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function pickAndUpload() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "videos",
    });
    if (result.canceled) return;

    setError(null);
    setPercentage(0);

    const upload = new FastPixUpload({
      endpoint: createUploadUrl,
      fileUri: result.assets[0].uri,
      chunkSize: 5 * 1024, // 5 MB, in KB (must be a multiple of 256 KB)
    });
    uploadRef.current = upload;

    upload.on("progress", ({ percentage }) => setPercentage(percentage));
    upload.on("success", () => setStatus("success"));
    upload.on("error", ({ message }) => {
      setError(message);
      setStatus("error");
    });

    setStatus("uploading");
    await upload.start();
  }

  function togglePause() {
    const upload = uploadRef.current;
    if (!upload) return;
    if (status === "uploading") {
      upload.pause();
      setStatus("paused");
    } else if (status === "paused") {
      upload.resume();
      setStatus("uploading");
    }
  }

  const statusLine =
    status === "success"
      ? "Upload complete"
      : status === "error"
        ? `Failed: ${error}`
        : status === "idle"
          ? "Pick a video to start"
          : `${percentage}%`;

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>FastPix React Native Uploads</Text>

      <Button title="Pick a video to upload" onPress={pickAndUpload} />

      {status !== "idle" && (
        <View style={styles.progressBlock}>
          <Text style={styles.status}>{statusLine}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${percentage}%` }]} />
          </View>
          {(status === "uploading" || status === "paused") && (
            <Button
              title={status === "paused" ? "Resume" : "Pause"}
              onPress={togglePause}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    gap: 20,
    backgroundColor: "#fff",
  },
  title: { fontSize: 18, fontWeight: "600", textAlign: "center" },
  progressBlock: { gap: 10 },
  status: { fontSize: 16, textAlign: "center" },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e0e0e0",
    overflow: "hidden",
  },
  fill: { height: "100%", backgroundColor: "#0a84ff" },
});
