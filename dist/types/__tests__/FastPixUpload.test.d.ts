/**
 * FastPixUpload integration tests — Phase 5
 *
 * Tests the full public API: start / pause / resume / abort, the FSM
 * state machine, all lifecycle events, network resilience, and the Phase 4
 * resume offset sync. Every native dependency is mocked so the suite runs
 * in Node without a React Native environment.
 *
 * Mock boundary:
 *   react-native-blob-util  →  fake file stat (10 MB) + fake readStream
 *   axios                   →  controlled PUT responses
 *   @react-native-community/netinfo → controlled connectivity callbacks
 */
export {};
//# sourceMappingURL=FastPixUpload.test.d.ts.map