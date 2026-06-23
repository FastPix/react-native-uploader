import { NetworkMonitor } from '../src/core/NetworkMonitor';

jest.mock('../utils/logger', () => ({
  log: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

import { warn } from '../src/utils/logger';

//  NetInfo mock 
type NetInfoStateChangeHandler = (state: NetInfoStateMock) => void;

interface NetInfoStateMock {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  type: string;
}

let registeredHandlers: NetInfoStateChangeHandler[] = [];

const mockNetInfoFetch = jest.fn();
const mockUnsubscribe = jest.fn();

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn((handler: NetInfoStateChangeHandler) => {
    registeredHandlers.push(handler);
    return mockUnsubscribe;
  }),
  fetch: mockNetInfoFetch,
}));

import NetInfo from '@react-native-community/netinfo';

function simulateNetworkChange(state: NetInfoStateMock): void {
  registeredHandlers.forEach((h) => h(state));
}

const onlineState: NetInfoStateMock = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
};

const offlineState: NetInfoStateMock = {
  isConnected: false,
  isInternetReachable: false,
  type: 'none',
};

const unknownState: NetInfoStateMock = {
  isConnected: true,
  isInternetReachable: null,
  type: 'wifi',
};

describe('NetworkMonitor', () => {
  let monitor: NetworkMonitor;

  beforeEach(() => {
    registeredHandlers = [];
    mockUnsubscribe.mockReset();
    mockNetInfoFetch.mockReset();
    jest.clearAllMocks();
    monitor = new NetworkMonitor();
  });

  afterEach(() => {
    monitor.stop();
  });

  // initial state 
  describe('initial state', () => {
    it('currentStatus is "unknown" before start()', () => {
      expect(monitor.currentStatus).toBe('unknown');
    });
  });

  // start() 
  describe('start()', () => {
    it('subscribes to NetInfo.addEventListener', () => {
      monitor.start();
      expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    });

    it('does not subscribe a second time if already started', () => {
      monitor.start();
      monitor.start();
      expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    });
  });

  // stop() 
  describe('stop()', () => {
    it('calls the unsubscribe function returned by addEventListener', () => {
      monitor.start();
      monitor.stop();
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('clears all registered onChange callbacks', () => {
      const cb = jest.fn();
      monitor.start();
      monitor.onChange(cb);
      monitor.stop();
      // Re-subscribe to trigger a change and confirm callback is gone
      monitor.start();
      simulateNetworkChange(onlineState);
      expect(cb).not.toHaveBeenCalled();
    });

    it('is safe to call when not started', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });

  // onChange() 
  describe('onChange()', () => {
    it('registers a callback and notifies it on network status change', () => {
      const cb = jest.fn();
      monitor.start();
      monitor.onChange(cb);
      simulateNetworkChange(onlineState);
      expect(cb).toHaveBeenCalledWith('online');
    });

    it('returns a cleanup function that unregisters the callback', () => {
      const cb = jest.fn();
      monitor.start();
      const cleanup = monitor.onChange(cb);
      cleanup();
      simulateNetworkChange(onlineState);
      expect(cb).not.toHaveBeenCalled();
    });

    it('supports multiple independent callbacks', () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      monitor.start();
      monitor.onChange(cb1);
      monitor.onChange(cb2);
      simulateNetworkChange(offlineState);
      expect(cb1).toHaveBeenCalledWith('offline');
      expect(cb2).toHaveBeenCalledWith('offline');
    });
  });

  // ── status derivation ─────────────────────
  describe('network status derivation', () => {
    beforeEach(() => monitor.start());

    it('derives "offline" when isConnected is false', () => {
      const cb = jest.fn();
      monitor.onChange(cb);
      simulateNetworkChange(offlineState);
      expect(cb).toHaveBeenCalledWith('offline');
    });

    it('derives "online" when connected and reachable', () => {
      const cb = jest.fn();
      monitor.onChange(cb);
      simulateNetworkChange(onlineState);
      expect(cb).toHaveBeenCalledWith('online');
    });

    it('derives "unknown" when connected but isInternetReachable is null', () => {
      const cb = jest.fn();
      monitor.onChange(cb);
      simulateNetworkChange(unknownState);
      expect(cb).toHaveBeenCalledWith('unknown');
    });

    it('derives "offline" when connected but isInternetReachable is false', () => {
      const cb = jest.fn();
      monitor.onChange(cb);
      simulateNetworkChange({ isConnected: true, isInternetReachable: false, type: 'wifi' });
      expect(cb).toHaveBeenCalledWith('offline');
    });
  });

  // deduplication 
  describe('status deduplication', () => {
    it('does not notify callbacks when status has not changed', () => {
      const cb = jest.fn();
      monitor.start();
      monitor.onChange(cb);

      // First change: unknown → online
      simulateNetworkChange(onlineState);
      expect(cb).toHaveBeenCalledTimes(1);

      // Second change with same derived status: still online
      simulateNetworkChange({ ...onlineState, type: 'cellular' });
      expect(cb).toHaveBeenCalledTimes(1); // no second call
    });

    it('updates currentStatus after each unique transition', () => {
      monitor.start();
      simulateNetworkChange(onlineState);
      expect(monitor.currentStatus).toBe('online');

      simulateNetworkChange(offlineState);
      expect(monitor.currentStatus).toBe('offline');
    });
  });

  // callback error isolation
  describe('callback error isolation', () => {
    it('warns and continues notifying remaining callbacks when one throws', () => {
      const badCb = jest.fn().mockImplementation(() => {
        throw new Error('callback error');
      });
      const goodCb = jest.fn();

      monitor.start();
      monitor.onChange(badCb);
      monitor.onChange(goodCb);
      simulateNetworkChange(onlineState);

      expect(badCb).toHaveBeenCalledTimes(1);
      expect(goodCb).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Callback error:'),
        expect.any(Error),
      );
    });
  });

  // fetchCurrentStatus()
  describe('fetchCurrentStatus()', () => {
    it('returns "online" when NetInfo.fetch reports connected and reachable', async () => {
      mockNetInfoFetch.mockResolvedValue(onlineState);
      const status = await monitor.fetchCurrentStatus();
      expect(status).toBe('online');
    });

    it('returns "offline" when NetInfo.fetch reports disconnected', async () => {
      mockNetInfoFetch.mockResolvedValue(offlineState);
      const status = await monitor.fetchCurrentStatus();
      expect(status).toBe('offline');
    });

    it('returns "unknown" when isInternetReachable is null', async () => {
      mockNetInfoFetch.mockResolvedValue(unknownState);
      const status = await monitor.fetchCurrentStatus();
      expect(status).toBe('unknown');
    });
  });
});