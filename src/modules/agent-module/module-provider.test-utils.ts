/**
 * Shared mock factories for the claude/opencode module-provider integration
 * tests: a fake binary resolver, and a canned server manager with start/stop
 * trigger capture.
 */

import { vi } from "vitest";
import type { AgentBinaryResolver, ResolvedAgentBinary } from "./binary-resolver";

/** A fake resolver: `prepare()` reports `needsDownload`, `download()` lands `binary`. */
export interface FakeBinaryResolver extends AgentBinaryResolver {
  readonly downloads: number;
}

/**
 * Create a fake binary resolver. By default the binary is already resolved
 * (nothing to download); pass `needsDownload: true` to model a first start.
 */
export function createFakeBinaryResolver(
  options: { binary?: ResolvedAgentBinary; needsDownload?: boolean } = {}
): FakeBinaryResolver {
  const binary: ResolvedAgentBinary = options.binary ?? {
    path: "/bundles/agent/1.0.0/agent",
    source: "download",
    version: "1.0.0",
  };
  let pending = options.needsDownload ?? false;
  let downloads = 0;
  return {
    get downloads() {
      return downloads;
    },
    prepare: async () => ({ needsDownload: pending }),
    download: async () => {
      if (!pending) return;
      downloads++;
      pending = false;
    },
    current: () => (pending ? null : binary),
    seed: async () => binary.version ?? "system",
    bundleVersionsInUse: () => (binary.version ? [binary.version] : []),
    idle: async () => undefined,
  };
}

/** Fire the handlers registered via on-server-started/stopped. */
export interface ServerManagerTriggers {
  _triggerStarted(workspacePath: string, port: number, pendingPrompt?: unknown): void;
  _triggerStopped(workspacePath: string, isRestart: boolean): void;
}

/**
 * Canned server-manager mock with the members shared by both agents
 * (startServer resolves 8080, stop/restart succeed) plus trigger capture for
 * the started/stopped callbacks. Pass agent-specific members via `extras` and
 * cast the result to the concrete server-manager type at the call site.
 */
export function createMockServerManager(
  extras: Record<string, unknown> = {}
): ServerManagerTriggers & Record<string, unknown> {
  let startedHandler:
    | ((workspacePath: string, port: number, pendingPrompt?: unknown) => void)
    | null = null;
  let stoppedHandler: ((workspacePath: string, isRestart: boolean) => void) | null = null;

  return {
    startServer: vi.fn().mockResolvedValue(8080),
    stopServer: vi.fn().mockResolvedValue({ success: true }),
    restartServer: vi.fn().mockResolvedValue({ success: true, port: 8080 }),
    dispose: vi.fn().mockResolvedValue(undefined),
    setMcpConfig: vi.fn(),
    onServerStarted: vi.fn(
      (cb: (workspacePath: string, port: number, pendingPrompt?: unknown) => void) => {
        startedHandler = cb;
        return vi.fn();
      }
    ),
    onServerStopped: vi.fn((cb: (workspacePath: string, isRestart: boolean) => void) => {
      stoppedHandler = cb;
      return vi.fn();
    }),
    _triggerStarted(workspacePath: string, port: number, pendingPrompt?: unknown) {
      startedHandler?.(workspacePath, port, pendingPrompt);
    },
    _triggerStopped(workspacePath: string, isRestart: boolean) {
      stoppedHandler?.(workspacePath, isRestart);
    },
    ...extras,
  };
}
