/**
 * Shared mock factories for the claude/opencode module-provider integration
 * tests: download deps, binary/version config, and a canned server manager
 * with start/stop trigger capture.
 */

import { vi } from "vitest";
import type { DownloadDeps, ArchiveExtension } from "../../utils/binary-download";
import { createFileSystemMock } from "../../boundaries/platform/filesystem.state-mock";
import { createMockHttpClient } from "../../boundaries/platform/http-client.state-mock";
import { createArchiveExtractorMock } from "../../boundaries/platform/archive-extractor.state-mock";
import { createMockAccessor } from "../../boundaries/platform/config.test-utils";
import type { PersistedAccessor } from "../../boundaries/platform/store-definition";

/** Create mock download dependencies. */
export function createDownloadDeps(): DownloadDeps {
  return {
    httpClient: createMockHttpClient(),
    fileSystemLayer: createFileSystemMock(),
    archiveExtractor: createArchiveExtractorMock(),
  };
}

/** Create a binary config whose executable matches the agent name. */
export function createBinaryConfig<TName extends string>(name: TName) {
  return {
    name,
    executablePath: name,
    archiveExtension: ".tar.gz" as ArchiveExtension,
  };
}

/**
 * Create a version-override accessor for the given config key.
 * Pass the type argument explicitly when the provider's deps demand a
 * specific nullability (e.g. `createVersionConfig<string>(...)`).
 */
export function createVersionConfig<T extends string | null = string | null>(
  key: string,
  version: T
): PersistedAccessor<T> {
  return createMockAccessor<T>(key, version);
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
