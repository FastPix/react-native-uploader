import React, {useEffect, useRef, useState} from 'react';
import RNFS from 'react-native-fs';
import RNBlobUtil from 'react-native-blob-util';
import {
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  Platform,
} from 'react-native';
import {launchImageLibrary} from 'react-native-image-picker';
import NetInfo from '@react-native-community/netinfo';
import {FastPixUpload} from 'react-native-uploads';

import ApiService from './Services/ApiService';

type LogType = 'info' | 'success' | 'warning' | 'error';

interface LogEntry {
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
  const [eta, setEta] = useState('--');
  const [chunkSuccess, setChunkSuccess] = useState(0);
  const [chunkRetries, setChunkRetries] = useState(0);
  const [failures, setFailures] = useState(0);
  const [chunkSize, setChunkSize] = useState('5120');
  const [maxRetries, setMaxRetries] = useState('3');
  const [retryDelay, setRetryDelay] = useState('1000');
  const scrollRef = useRef<ScrollView>(null);
  const speedRef = useRef({ bytes: 0, time: Date.now() });

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setNetworkOnline(!!state.isConnected);
    });
    return unsubscribe;
  }, []);

  const addLog = (message: string, type: LogType = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{time, message, type}, ...prev]);
    console.log(`[${time}] ${message}`);
  };

  const clearLogs = () => setLogs([]);

  const formatBytes = (bytes: number) => {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const resetStats = () => {
    setProgress(0);
    setBytesUploaded(0);
    setBytesTotal(0);
    setChunkSuccess(0);
    setChunkRetries(0);
    setFailures(0);
    setSpeed('0 KB/s');
    setEta('--');
  };

  const pickAndUpload = async () => {
    try {
      resetStats();

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

      const upload = new FastPixUpload({
        endpoint: uploadDetails.url,
        fileUri: asset.uri,
        chunkSize: Number(chunkSize),
        maxRetries: Number(maxRetries),
        retryDelay: Number(retryDelay),
        autoHandleNetworkEvents: true,
        maxFileSize: 5 * 1024 * 1024 // 100 MB Limit
      });

      setUploadRef(upload);

      upload.on('started', ({fileSize}) => {
        setUploadState('Uploading');
        addLog(`Upload Started (${formatBytes(fileSize)})`, 'success');
      });

      upload.on('progress', ({percentage, bytesUploaded, bytesTotal}) => {
        setProgress(percentage / 100);
        setBytesUploaded(bytesUploaded);
        setBytesTotal(bytesTotal);

        const now = Date.now();
        const elapsed = (now - speedRef.current.time) / 1000;

        if (elapsed >= 1) {
          const uploadedDiff = bytesUploaded - speedRef.current.bytes;
          const kbps = uploadedDiff / elapsed / 1024;
          setSpeed(`${kbps.toFixed(2)} KB/s`);

          if (kbps > 0) {
            const remainingBytes = bytesTotal - bytesUploaded;
            const remainingSeconds = remainingBytes / (kbps * 1024);
            setEta(`${Math.ceil(remainingSeconds)} sec`);
          }

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
        setFailures(prev => prev + 1);
        setUploadState('Failed');
        addLog(message, 'error');
      });

      upload.on('pause', ({reason}) => {
        setUploadState('Paused');
        addLog(`Paused (${reason})`, 'warning');
      });

      upload.on('resume', ({fromOffset}) => {
        setUploadState('Uploading');
        addLog(`Resumed from ${fromOffset}`, 'success');
      });

      upload.on('offline', () => addLog('Network Offline', 'warning'));
      upload.on('online', () => addLog('Network Online', 'success'));

      // ── Step 7: start ─────────────────────────────────────────────────────
      await upload.start();

    } catch (error: any) {
      addLog(error?.message ?? 'Unknown error occurred', 'error');
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
    <SafeAreaView style={styles.container}>
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
          <TextInput
            style={styles.input}
            value={chunkSize}
            onChangeText={setChunkSize}
            placeholder="Chunk Size"
            keyboardType="numeric"
          />
          <TextInput
            style={styles.input}
            value={maxRetries}
            onChangeText={setMaxRetries}
            placeholder="Retries"
            keyboardType="numeric"
          />
          <TextInput
            style={styles.input}
            value={retryDelay}
            onChangeText={setRetryDelay}
            placeholder="Retry Delay"
            keyboardType="numeric"
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
          {/* <Text>Speed: {speed}</Text>
          <Text>ETA: {eta}</Text> */}
        </View>

        {/* Buttons */}
        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.primaryButton} onPress={pickAndUpload}>
            <Text style={styles.buttonText}>Upload</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => uploadRef?.pause()}>
            <Text style={styles.buttonText}>Pause</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => uploadRef?.resume()}>
            <Text style={styles.buttonText}>Resume</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.dangerButton}
            onPress={() => {
              uploadRef?.abort();
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
            {logs.map((log, index) => (
              <Text
                key={index}
                style={{color: getLogColor(log.type), marginBottom: 6}}>
                [{log.time}] {log.message}
              </Text>
            ))}
          </ScrollView>
        </View>
      </ScrollView>
    </SafeAreaView>
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