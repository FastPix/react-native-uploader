/**
 * @fastpix/react-native-uploads
 *
 * Official FastPix Upload SDK for React Native (Android & iOS).
 * Phases 1–5 complete.
 *
 * Single entry point — import everything from here.
 */

// ── Primary class ─────────────────────────────────────────────────────────────
export { FastPixUpload } from './core/FastPixUpload';

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  FastPixUploadOptions,
  UploadState,
  UploadEventName,
  UploadEventCallback,
  UploadEventPayloads,
  UploadProgressSnapshot,
  ChunkMeta,
} from './types';
