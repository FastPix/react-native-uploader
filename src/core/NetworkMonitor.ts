import NetInfo from '@react-native-community/netinfo';
import type { NetInfoState, NetInfoSubscription } from '@react-native-community/netinfo';
import { log, warn } from '../utils/logger';

export type NetworkStatus = 'online' | 'offline' | 'unknown';

export type NetworkChangeCallback = (status: NetworkStatus) => void;

/**
 * Fired when the physical transport changes (e.g. wifi <-> cellular) while the
 * device stays "online". The in-flight socket dies on such a switch, but NetInfo
 * keeps reporting "online", so status-only listeners never see it.
 */
export type TransportChangeCallback = (
  type: string,
  previousType: string | null,
) => void;

export class NetworkMonitor {
  private _subscription: NetInfoSubscription | null = null;
  private _currentStatus: NetworkStatus = 'unknown';
  private _currentType: string | null = null;
  private readonly _callbacks = new Set<NetworkChangeCallback>();
  private readonly _transportCallbacks = new Set<TransportChangeCallback>();

  /** Start listening to network state changes. */
  start(): void {
    if (this._subscription) {
      log('[FastPix:NetworkMonitor] start() called but already listening', {
        timestamp: new Date().toISOString(),
        currentStatus: this._currentStatus,
      });
      return; 
    }

    log('[FastPix:NetworkMonitor] start() called - subscribing to network changes', {
      timestamp: new Date().toISOString(),
    });

    this._subscription = NetInfo.addEventListener(
      this._handleStateChange.bind(this),
    );
  }

  /** Stop listening and clean up the native subscription. */
  stop(): void {
    log('[FastPix:NetworkMonitor] stop() called', {
      timestamp: new Date().toISOString(),
      currentStatus: this._currentStatus,
      callbackCount: this._callbacks.size,
    });
    this._subscription?.();
    this._subscription = null;
    this._callbacks.clear();
    this._transportCallbacks.clear();
    this._currentType = null;
  }

  /** Register a callback to be notified of network status changes. */
  onChange(callback: NetworkChangeCallback): () => void {
    log('[FastPix:NetworkMonitor] onChange() - registering callback', {
      timestamp: new Date().toISOString(),
      callbackCount: this._callbacks.size + 1,
    });
    this._callbacks.add(callback);
    return () => {
      this._callbacks.delete(callback);
      log('[FastPix:NetworkMonitor] onChange cleanup - callback unregistered', {
        timestamp: new Date().toISOString(),
        callbackCount: this._callbacks.size,
      });
    };
  }

  /**
   * Register a callback for physical transport changes (e.g. wifi <-> cellular)
   * that happen while the device stays online. Returns an unsubscribe function.
   */
  onTransportChange(callback: TransportChangeCallback): () => void {
    this._transportCallbacks.add(callback);
    return () => {
      this._transportCallbacks.delete(callback);
    };
  }

  /** Returns the last known network status. */
  get currentStatus(): NetworkStatus {
    return this._currentStatus;
  }

  /** Returns the last known transport type (e.g. "wifi", "cellular"). */
  get currentType(): string | null {
    return this._currentType;
  }


  async fetchCurrentStatus(): Promise<NetworkStatus> {
    const state = await NetInfo.fetch();
    return this._deriveStatus(state);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _handleStateChange(state: NetInfoState): void {
    const newStatus = this._deriveStatus(state);
    const newType = state.type;

    // Detect a transport switch (e.g. wifi <-> cellular) even when the
    // online/offline status is unchanged. On such a switch the in-flight socket
    // dies but NetInfo keeps reporting "online", so status-only listeners miss
    // it. The very first observation (previousType === null) is not a "change".
    const previousType = this._currentType;
    this._currentType = newType;

    if (previousType !== null && newType !== previousType) {
      log('[FastPix:NetworkMonitor] Transport type changed', {
        timestamp: new Date().toISOString(),
        previousType,
        newType,
        status: newStatus,
        transportCallbackCount: this._transportCallbacks.size,
      });
      this._transportCallbacks.forEach((cb) => {
        try {
          cb(newType, previousType);
        } catch (err) {
          warn('[FastPix:NetworkMonitor] Transport callback error:', err);
        }
      });
    }

    if (newStatus === this._currentStatus) {
      log('[FastPix:NetworkMonitor] Network state changed but status unchanged', {
        timestamp: new Date().toISOString(),
        status: newStatus,
        isConnected: state.isConnected,
        isInternetReachable: state.isInternetReachable,
      });
      return; 
    }

    const previousStatus = this._currentStatus;
    this._currentStatus = newStatus;
    
    log('[FastPix:NetworkMonitor] Network status changed', {
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
        warn('[FastPix:NetworkMonitor] Callback error:', err);
      }
    });
  }

  private _deriveStatus(state: NetInfoState): NetworkStatus {
    log('[FastPix:NetworkMonitor] Deriving status from NetInfoState', {
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
