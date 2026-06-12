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
export type NetworkStatus = 'online' | 'offline' | 'unknown';
export type NetworkChangeCallback = (status: NetworkStatus) => void;
export declare class NetworkMonitor {
    private _subscription;
    private _currentStatus;
    private readonly _callbacks;
    /** Start listening to network state changes. */
    start(): void;
    /** Stop listening and clean up the native subscription. */
    stop(): void;
    /** Register a callback to be notified of network status changes. */
    onChange(callback: NetworkChangeCallback): () => void;
    /** Returns the last known network status. */
    get currentStatus(): NetworkStatus;
    /**
     * Returns a one-shot promise resolving to the current network status.
     * Useful for an initial check before starting an upload.
     */
    fetchCurrentStatus(): Promise<NetworkStatus>;
    private _handleStateChange;
    /**
     * Maps a `NetInfoState` to our simplified `NetworkStatus`.
     *
     * `isInternetReachable` can be `null` when the platform hasn't finished
     * probing yet — we treat that as `'unknown'` rather than either definitive
     * state.
     */
    private _deriveStatus;
}
//# sourceMappingURL=NetworkMonitor.d.ts.map