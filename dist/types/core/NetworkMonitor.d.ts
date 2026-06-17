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
    fetchCurrentStatus(): Promise<NetworkStatus>;
    private _handleStateChange;
    private _deriveStatus;
}
//# sourceMappingURL=NetworkMonitor.d.ts.map