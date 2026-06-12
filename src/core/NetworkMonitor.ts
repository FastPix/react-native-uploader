/**
 * NetworkMonitor
 *
 * Wraps `@react-native-community/netinfo` to expose a simple
 * "is the device online?" reactive interface that the upload engine
 * can subscribe to.
 *
 * Design decisions:
 * - Checks both `isConnected` (network interface up) and
 *   `isInternetReachable` (actual internet access confirmed) before
 *   reporting the device as online — matching the design document's
 *   "Network State Auditing" requirement.
 * - The class is deliberately side-effect–free until `start()` is
 *   called, so it can be constructed without immediately consuming
 *   resources.
 */

import NetInfo from '@react-native-community/netinfo';
import type { NetInfoState, NetInfoSubscription } from '@react-native-community/netinfo';

export type NetworkStatus = 'online' | 'offline' | 'unknown';

export type NetworkChangeCallback = (status: NetworkStatus) => void;

export class NetworkMonitor {
  private _subscription: NetInfoSubscription | null = null;
  private _currentStatus: NetworkStatus = 'unknown';
  private readonly _callbacks = new Set<NetworkChangeCallback>();

  /** Start listening to network state changes. */
  start(): void {
    if (this._subscription) {
      console.log('[FastPix:NetworkMonitor] start() called but already listening', {
        timestamp: new Date().toISOString(),
        currentStatus: this._currentStatus,
      });
      return; // Already listening.
    }

    console.log('[FastPix:NetworkMonitor] start() called - subscribing to network changes', {
      timestamp: new Date().toISOString(),
    });

    this._subscription = NetInfo.addEventListener(
      this._handleStateChange.bind(this),
    );
  }

  /** Stop listening and clean up the native subscription. */
  stop(): void {
    console.log('[FastPix:NetworkMonitor] stop() called', {
      timestamp: new Date().toISOString(),
      currentStatus: this._currentStatus,
      callbackCount: this._callbacks.size,
    });
    this._subscription?.();
    this._subscription = null;
    this._callbacks.clear();
  }

  /** Register a callback to be notified of network status changes. */
  onChange(callback: NetworkChangeCallback): () => void {
    console.log('[FastPix:NetworkMonitor] onChange() - registering callback', {
      timestamp: new Date().toISOString(),
      callbackCount: this._callbacks.size + 1,
    });
    this._callbacks.add(callback);
    return () => {
      this._callbacks.delete(callback);
      console.log('[FastPix:NetworkMonitor] onChange cleanup - callback unregistered', {
        timestamp: new Date().toISOString(),
        callbackCount: this._callbacks.size,
      });
    };
  }

  /** Returns the last known network status. */
  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  /**
   * Returns a one-shot promise resolving to the current network status.
   * Useful for an initial check before starting an upload.
   */
  async fetchCurrentStatus(): Promise<NetworkStatus> {
    const state = await NetInfo.fetch();
    return this._deriveStatus(state);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _handleStateChange(state: NetInfoState): void {
    const newStatus = this._deriveStatus(state);
    if (newStatus === this._currentStatus) {
      console.log('[FastPix:NetworkMonitor] Network state changed but status unchanged', {
        timestamp: new Date().toISOString(),
        status: newStatus,
        isConnected: state.isConnected,
        isInternetReachable: state.isInternetReachable,
      });
      return; // No change – skip redundant notifications.
    }

    const previousStatus = this._currentStatus;
    this._currentStatus = newStatus;
    
    console.log('[FastPix:NetworkMonitor] Network status changed', {
      timestamp: new Date().toISOString(),
      previousStatus,
      newStatus,
      isConnected: state.isConnected,
      isInternetReachable: state.isInternetReachable,
      type: state.type,
      callbackCount: this._callbacks.size,
    });

    this._callbacks.forEach((cb) => {
      try {
        cb(newStatus);
      } catch (err) {
        console.warn('[FastPix:NetworkMonitor] Callback error:', err);
      }
    });
  }

  /**
   * Maps a `NetInfoState` to our simplified `NetworkStatus`.
   *
   * `isInternetReachable` can be `null` when the platform hasn't finished
   * probing yet — we treat that as `'unknown'` rather than either definitive
   * state.
   */
  private _deriveStatus(state: NetInfoState): NetworkStatus {
    console.log('[FastPix:NetworkMonitor] Deriving status from NetInfoState', {
      timestamp: new Date().toISOString(),
      isConnected: state.isConnected,
      isInternetReachable: state.isInternetReachable,
      type: state.type,
    });

    if (!state.isConnected) {
      return 'offline';
    }
    if (state.isInternetReachable === null) {
      return 'unknown';
    }
    return state.isInternetReachable ? 'online' : 'offline';
  }
}
