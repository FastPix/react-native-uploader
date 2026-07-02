import React, {useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
} from 'react-native';
import {launchImageLibrary} from 'react-native-image-picker';
import NetInfo from '@react-native-community/netinfo';
import {FastPixUpload} from 'react-native-uploads';

import ApiService from './Services/ApiService';

type LogType = 'info' | 'success' | 'warning' | 'error';

interface LogEntry {
  id: string;
  time: string;
  message: string;
  type: LogType;
}

export default function App() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [uploadRef, setUploadRef] = useState<FastPixUpload | null>(null);
  const [fileInfo, setFileInfo] = useState<any>(null);
  const [uploadState, setUploadState] = useState('Idle');
  const [networkOnline, setNetworkOnline] = useState(true);
  const [progress, setProgress] = useState(0);
  const [bytesUploaded, setBytesUploaded] = useState(0);
  const [bytesTotal, setBytesTotal] = useState(0);
  const [speed, setSpeed] = useState('0 KB/s');
  const [chunkSuccess, setChunkSuccess] = useState(0);
  const [chunkRetries, setChunkRetries] = useState(0);
  const [failures, setFailures] = useState(0);
  const [chunkSize, setChunkSize] = useState('5120');
  const [maxFileSize, setMaxFileSize] = useState('0')
  const [maxRetries, setMaxRetries] = useState('3');
  const [retryDelay, setRetryDelay] = useState('1000');
  const scrollRef = useRef<ScrollView>(null);
  const speedRef = useRef({ bytes: 0, time: Date.now() });
  const logCounterRef = useRef(0);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setNetworkOnline(!!state.isConnected);
    });
    return unsubscribe;
  }, []);

  const addLog = (message: string, type: LogType = 'info') => {
    const time = new Date().toLocaleTimeString();
    logCounterRef.current += 1;
    const log: LogEntry = {
      id: `${Date.now()}-${logCounterRef.current}`,
      time,
      message,
      type,
    };

    setLogs(prev => [log, ...prev]);
    console.log(`[${time}] ${message}`);
  };

  const clearLogs = () => setLogs([]);

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Number.parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const resetStats = () => {
    setProgress(0);
    setBytesUploaded(0);
    setBytesTotal(0);
    setChunkSuccess(0);
    setChunkRetries(0);
    setFailures(0);
    setSpeed('0 KB/s');
    // Reset the speed baseline so a new upload doesn't diff its bytes against
    // the previous upload's byte count (which produced a negative first reading
    // after abort → new upload).
    speedRef.current = { bytes: 0, time: Date.now() };
  };

  const cleanUpSession = () => {
    resetStats();
    setUploadState('Idle');
    setFileInfo(null);
  }

  const pickAndUpload = async () => {
    try {
      cleanUpSession();

      const result = await launchImageLibrary({mediaType: 'video'});
      const asset = result.assets?.[0];

      if (!asset?.uri) {
        addLog('No file selected', 'warning');
        return;
      }

      setFileInfo(asset);
      addLog(`Selected file: ${asset.fileName}`, 'success');
      console.log(asset);

      setUploadState('Getting Upload URL');

      const uploadDetails = await ApiService.createDirectUpload();

      if (!uploadDetails?.url) {
        addLog('Failed to get upload URL', 'error');
        return;
      }

      addLog(`Upload ID: ${uploadDetails.uploadId}`);

      addLog('Entering to uploading phase...');

      console.log('Original asset uri:', asset.uri);
      console.log('Final uri passed to SDK:', asset.uri);

      addLog(`Chunk Size: ${chunkSize}`);

      addLog(`Max file size : ${maxFileSize}`)

      const upload = new FastPixUpload({
        endpoint: uploadDetails.url,
        fileUri: asset.uri,
        chunkSize: chunkSize.trim() ? Number(chunkSize) : undefined,
        maxRetries: maxRetries.trim() ? Number(maxRetries) : undefined,
        retryDelay: retryDelay.trim() ? Number(retryDelay) : undefined,
        maxFileSize: maxFileSize.trim() ? Number(maxFileSize) : undefined, // 10 * 1024 Kb Limit
        enableLogs: true
      });

      setUploadRef(upload);

      upload.on('started', ({fileSize}) => {
        setUploadState('Uploading');
        addLog(`Upload Started (${formatBytes(fileSize)})`, 'success');
      });

      upload.on('progress', ({percentage, bytesUploaded, bytesTotal}) => {
      addLog(`Percentage : ${percentage}`)
        setProgress(percentage / 100);
        setBytesUploaded(bytesUploaded);
        setBytesTotal(bytesTotal);

        const now = Date.now();
        const elapsed = (now - speedRef.current.time) / 1000;

        if (elapsed >= 1) {
          const uploadedDiff = bytesUploaded - speedRef.current.bytes;
          // Clamp to 0: if bytesUploaded ever dips below the previous baseline
          // (stale tick from a prior session), never show a negative speed.
          const kbps = Math.max(0, uploadedDiff / elapsed / 1024);
          setSpeed(`${kbps.toFixed(2)} KB/s`);

          speedRef.current = {bytes: bytesUploaded, time: now};
        }
      });

      upload.on('stateChange', ({from, to}) => {
        setUploadState(to);
        addLog(`State Changed: ${from} → ${to}`);
      });

      upload.on('chunkAttempt', ({chunkIndex, attemptNumber, totalChunkNumbers}) => {
        addLog(`Chunk ${chunkIndex} / ${totalChunkNumbers}, Attempt ${attemptNumber}`);
      });

      upload.on('chunkAttemptFailure', ({chunkIndex, attemptNumber, error}) => {
        setChunkRetries(prev => prev + 1);
        addLog(`Chunk ${chunkIndex} Retry ${attemptNumber}: ${error.message}`, 'warning');
      });

      upload.on('chunkSuccess', ({chunkIndex}) => {
        setChunkSuccess(prev => prev + 1);
        addLog(`Chunk ${chunkIndex} Uploaded`, 'success');
      });

      upload.on('success', () => {
        setUploadState('Completed');
        addLog('Upload Completed Successfully', 'success');

      });

      upload.on('error', ({message}) => {
        addLog(message, 'error');
        // Clear the stale upload details (progress bar, chunk stats, file info)
        // once the upload has failed, then surface the Failed state — which also
        // re-enables the Upload button.
        resetStats();
        setFileInfo(null);
        setUploadState('Failed');
      });

      upload.on('pause', ({reason}) => {
        setUploadState('Paused');
        addLog(`Paused (${reason})`, 'warning');
      });

      upload.on('resume', ({fromOffset}) => {
        setUploadState('Uploading');
        addLog(`Resumed from ${fromOffset}`, 'success');
      });

      upload.on('abort', () => {
        setUploadState('Aborted');
        cleanUpSession();
        addLog('Upload aborted.', 'warning');
      });

      upload.on('offline', () => addLog('Network Offline', 'warning'));
      upload.on('online', () => addLog('Network Online', 'success'));

      // ── Step 7: start ─────────────────────────────────────────────────────
      await upload.start();

    } catch (error: any) {
      addLog(error?.message ?? 'Unknown error occurred', 'error');
      // Validation/setup failed (e.g. chunk size not divisible by 256).
      // Clear the session so the Upload button becomes active again.
      cleanUpSession();
    }
  };

  const getLogColor = (type: LogType) => {
    switch (type) {
      case 'success': return '#16a34a';
      case 'warning': return '#f97316';
      case 'error':   return '#dc2626';
      default:        return '#374151';
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.pageContent}
        showsVerticalScrollIndicator={false}>
        <Text style={styles.header}>FastPix Upload SDK Tester</Text>

        {/* Network Card */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Network Status</Text>
          <Text>{networkOnline ? '🟢 Online' : '🔴 Offline'}</Text>
        </View>

        {/* Upload Config */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Upload Configuration</Text>
          <Text> Enter Chunk Size </Text>
          <TextInput
            style={styles.input}
            value={chunkSize}
            onChangeText={setChunkSize}
            placeholder="Chunk Size"
          />
          <Text> Enter Max Retries </Text>
          <TextInput
            style={styles.input}
            value={maxRetries}
            onChangeText={setMaxRetries}
            placeholder="Retries"
          />
          <Text> Enter Retry Delay  </Text>
          <TextInput
            style={styles.input}
            value={retryDelay}
            onChangeText={setRetryDelay}
            placeholder="Retry Delay"
          />

          <Text> Enter Max File Size Limit </Text>
          <TextInput
            style={styles.input}
            value={maxFileSize}
            onChangeText={setMaxFileSize}
            placeholder="Max File Size in bytes "
          />
        </View>

        {/* File Card */}
        {fileInfo && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>File Details</Text>
            <Text>Name: {fileInfo.fileName}</Text>
            <Text>Size: {formatBytes(fileInfo.fileSize || 0)}</Text>
            <Text>Type: {fileInfo.type}</Text>
          </View>
        )}

        {/* Status */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Upload Status</Text>
          <Text>State: {uploadState}</Text>
          <View style={styles.progressContainer}>
            <View
              style={[styles.progressFill, {width: `${progress * 100}%`}]}
            />
          </View>
          <Text>{(progress * 100).toFixed(1)}%</Text>
          <Text>
            {formatBytes(bytesUploaded)} / {formatBytes(bytesTotal)}
          </Text>
          <Text>Speed: {speed}</Text>
        </View>

        {/* Chunk Statistics */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Chunk Statistics</Text>
          <Text>Successful Chunks: {chunkSuccess}</Text>
          <Text>Chunk Retries: {chunkRetries}</Text>
          <Text>Failures: {failures}</Text>
        </View>

        {/* Buttons */}
        <View style={styles.buttonRow}>
          {(uploadState === 'Idle' ||
            uploadState === 'Completed' ||
            uploadState === 'Failed' || uploadState === 'Aborted') && (
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={pickAndUpload}>
              <Text style={styles.buttonText}>Upload</Text>
            </TouchableOpacity>
          )}

          {!(uploadState === 'Idle' || 
            uploadState === 'Completed' || 
            uploadState === 'Failed' || 
            uploadState === 'Aborted') && (
            <TouchableOpacity style={[styles.secondaryButton]}>
              <Text style={styles.buttonText}>Upload</Text>
            </TouchableOpacity>
          )} 
 
        {(uploadState === 'Uploading' || uploadState === 'UPLOADING') &&(
            <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => uploadRef?.pause()}>
            <Text style={styles.buttonText}>Pause</Text>
          </TouchableOpacity>
        )}
        {!(uploadState === 'Uploading' || uploadState === 'UPLOADING') &&(
            <TouchableOpacity
            style={styles.secondaryButton}>
            <Text style={styles.buttonText}>Pause</Text>
          </TouchableOpacity>
        )}

        {(uploadState === 'Paused') &&(
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => uploadRef?.resume()}>
            <Text style={styles.buttonText}>Resume</Text>
          </TouchableOpacity>
        )}

        {(uploadState !== 'Paused') &&(
          <TouchableOpacity
            style={styles.secondaryButton}>
            <Text style={styles.buttonText}>Resume</Text>
          </TouchableOpacity>
        )}
          
          <TouchableOpacity
            style={styles.dangerButton}
            onPress={() => {
              uploadRef?.abort();
              cleanUpSession();
              addLog('Upload aborted.');
            }}>
            <Text style={styles.buttonText}>Abort</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.clearButton} onPress={clearLogs}>
          <Text style={styles.buttonText}>Clear Logs</Text>
        </TouchableOpacity>

        {/* Logs */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Event Logs ({logs.length})</Text>
          <ScrollView nestedScrollEnabled style={styles.logs} ref={scrollRef}>
            {logs.map((log) => (
              <Text
                key={log.id}
                style={{color: getLogColor(log.type), marginBottom: 6}}>
                [{log.time}] {log.message}
              </Text>
            ))}
          </ScrollView>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container:         {flex: 1, backgroundColor: '#f3f4f6', padding: 12},
  header:            {fontSize: 24, fontWeight: '700', marginBottom: 12},
  card:              {backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10},
  sectionTitle:      {fontSize: 16, fontWeight: '700', marginBottom: 8},
  pageContent:       {paddingBottom: 40},
  value:             {fontSize: 15},
  input:             {borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, height: 42, marginBottom: 8, paddingHorizontal: 10},
  progressContainer: {height: 12, backgroundColor: '#e5e7eb', borderRadius: 8, overflow: 'hidden', marginVertical: 10},
  progressFill:      {height: '100%', backgroundColor: '#2563eb'},
  progressText:      {fontWeight: '700', marginBottom: 8},
  buttonRow:         {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10},
  primaryButton:     {backgroundColor: '#2563eb', padding: 10, borderRadius: 8},
  secondaryButton:   {backgroundColor: '#475569', padding: 10, borderRadius: 8},
  dangerButton:      {backgroundColor: '#dc2626', padding: 10, borderRadius: 8},
  clearButton:       {backgroundColor: '#7c3aed', padding: 10, borderRadius: 8, marginBottom: 10},
  buttonText:        {color: '#fff', fontWeight: '600'},
  logs:              {height: 300, backgroundColor: '#111827', borderRadius: 8, padding: 10},
});