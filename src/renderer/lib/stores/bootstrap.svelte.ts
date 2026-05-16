/**
 * Bootstrap store: app-wide data returned by lifecycle.ready().
 * Currently holds the global default agent and the list of agents whose
 * binaries are present on disk (for the create-workspace dropdown).
 */
import type { AgentInfo, LifecycleAgentType } from "@shared/ipc";

let _defaultAgent = $state<LifecycleAgentType | null>(null);
let _availableAgents = $state<readonly AgentInfo[]>([]);
let _initialized = $state<boolean>(false);

export const bootstrap = {
  get defaultAgent(): LifecycleAgentType | null {
    return _defaultAgent;
  },
  get availableAgents(): readonly AgentInfo[] {
    return _availableAgents;
  },
  get initialized(): boolean {
    return _initialized;
  },
};

export function setBootstrap(value: {
  defaultAgent: LifecycleAgentType | null;
  availableAgents: readonly AgentInfo[];
}): void {
  _defaultAgent = value.defaultAgent;
  _availableAgents = value.availableAgents;
  _initialized = true;
}

/** Reset bootstrap state. Used for testing. */
export function resetBootstrap(): void {
  _defaultAgent = null;
  _availableAgents = [];
  _initialized = false;
}
