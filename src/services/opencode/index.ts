/**
 * OpenCode integration services.
 * Public API for the opencode module.
 */

export { SiPortScanner, type PortScanner } from "./port-scanner";
export { PidtreeProvider, type ProcessTreeProvider } from "./process-tree";
export { HttpInstanceProbe, type InstanceProbe } from "./instance-probe";
export {
  DiscoveryService,
  type DiscoveryServiceDependencies,
  type InstancesChangedCallback,
} from "./discovery-service";
export { OpenCodeClient, type SessionEventCallback } from "./opencode-client";
export { AgentStatusManager, type StatusChangedCallback } from "./agent-status-manager";

// Re-export types
export type {
  Result,
  PortInfo,
  SessionStatus,
  IDisposable,
  Unsubscribe,
  DiscoveryError,
  ProbeError,
  ScanError,
} from "./types";

export { ok, err } from "./types";
