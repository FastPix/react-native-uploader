import React, { useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  Button,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { FastPixUpload } from 'react-native-uploads';
import ApiService from './Services/ApiService';

type LogEntry = { time: string; msg: string };

export default function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [uploadRef, setUploadRef] = useState<FastPixUpload | null>(null);

  const log = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [{ time, msg }, ...prev]);
    console.log(`[${time}] ${msg}`);
  };

  const pickAndUpload = async () => {
    // 1. Pick a video from the device library
    const result = await launchImageLibrary({ mediaType: 'video' });
    const asset = result.assets?.[0];
    if (!asset?.uri) {
      log('No file selected.');
      return;
    }

    log(`File picked: ${asset.fileName} (${asset.fileSize} bytes)`);
    log(`file path : ${asset.originalPath} and uri : ${asset.uri}`)

    // 2. TODO: replace this with a real signed URL from your FastPix server

    // get the signed url from server

    const uploadDetails = await ApiService.createDirectUpload();

    log(`Recieved upload details form Api : ${uploadDetails?.url} : ${uploadDetails?.uploadId}`);

    if(!uploadDetails)
    {
      log(`Failed to get upload url and upload id`);
    }

    log(`Entering to uploading phase...`);

    // 3. Create the upload instance
    const upload = new FastPixUpload({
      endpoint: uploadDetails?.url,
      fileUri: asset.uri,
      chunkSize: 5 * 1024,
      maxRetries: 3,
      retryDelay: 1000,
      autoHandleNetworkEvents: true,
    });

    log(`Upload instance created ${upload}`);

    setUploadRef(upload);

    // 4. Wire up all events
    upload.on('started', ({ fileSize }) =>
      log(`Started — ${fileSize} bytes`));

    upload.on('progress', ({ percentage, bytesUploaded, bytesTotal }) =>
      log(`Progress: ${percentage}% (${bytesUploaded}/${bytesTotal})`));

    upload.on('stateChange', ({ from, to }) =>
      log(`State: ${from} → ${to}`));

    upload.on('chunkAttempt', ({ chunkIndex, attemptNumber }) =>
      log(`Chunk ${chunkIndex} attempt ${attemptNumber}`));

    upload.on('chunkAttemptFailure', ({ chunkIndex, attemptNumber, error }) =>
      log(`⚠️ Chunk ${chunkIndex} attempt ${attemptNumber} failed: ${error.message}`));

    upload.on('chunkSuccess', ({ chunkIndex, offset }) =>
      log(`✅ Chunk ${chunkIndex} done. Offset: ${offset}`));

    upload.on('success', () =>
      log('🎉 Upload complete!'));

    upload.on('error', ({ message, code }) =>
      log(`❌ Error [${code}]: ${message}`));

    upload.on('pause', ({ reason }) =>
      log(`⏸ Paused (${reason})`));

    upload.on('resume', ({ fromOffset }) =>
      log(`▶️ Resumed from ${fromOffset}`));

    upload.on('offline', () => log('📵 Offline'));
    upload.on('online',  () => log('📶 Online'));

    // 5. Start ̰Platform
    
    await upload.start();
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>FastPix Upload SDK</Text>

      <View style={styles.buttons}>
        <Button title="Pick video & upload" onPress={pickAndUpload} />
        <Button
          title="Pause"
          onPress={() => uploadRef?.pause()}
        />
        <Button
          title="Resume"
          onPress={() => uploadRef?.resume()}
        />
        <Button
          title="Abort"
          onPress={() => {
            uploadRef?.abort();
            log('Aborted.');
          }}
        />
      </View>

      <Text style={styles.logTitle}>Event log:</Text>
      <ScrollView style={styles.logBox}>
        {logs.map((entry, i) => (
          <Text key={i} style={styles.logLine}>
            [{entry.time}] {entry.msg}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, padding: 16, backgroundColor: '#fff' },
  title:      { fontSize: 20, fontWeight: 'bold', marginBottom: 12 },
  buttons:    { gap: 8, marginBottom: 16 },
  logTitle:   { fontWeight: '600', marginBottom: 4 },
  logBox:     { flex: 1, backgroundColor: '#f5f5f5', padding: 8, borderRadius: 8 },
  logLine:    { fontSize: 11, fontFamily: 'monospace', marginBottom: 2 },
});