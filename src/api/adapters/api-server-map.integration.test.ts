// @vitest-environment node
/**
 * Conformance tests for the API server wire's mapping.
 *
 * The Record type already makes a missing operation a compile error. These cover
 * what the type cannot: that the names resolve to real entries, that no two
 * operations claim the same channel, and that the published channel names have
 * not moved — third-party extensions call these by name.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createLockModule } from "../../modules/lock-module";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createRegistry } from "../entries";
import { OPERATION_NAMES, type OperationName } from "../names";
import { API_SERVER_MAP } from "./api-server-map";

function registry() {
  return createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      readUserGuide: async () => "",
    },
    SILENT_LOGGER
  );
}

describe("API server map", () => {
  it("covers the whole operation vocabulary", () => {
    expect(Object.keys(API_SERVER_MAP).sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("names only operations the registry actually implements", () => {
    const reg = registry();
    for (const name of Object.keys(API_SERVER_MAP) as OperationName[]) {
      expect(() => reg.get(name), name).not.toThrow();
    }
  });

  it("gives each carried operation a unique channel", () => {
    const channels = Object.values(API_SERVER_MAP)
      .filter((m) => m !== null)
      .map((m) => m!.channel);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps the published channel names stable", () => {
    // docs/API.md documents these for third-party extensions; renaming one is a
    // breaking change to the Public API, not a refactor.
    expect(API_SERVER_MAP["workspace.status"]?.channel).toBe("api:workspace:getStatus");
    expect(API_SERVER_MAP["workspace.delete"]?.channel).toBe("api:workspace:delete");
    expect(API_SERVER_MAP["workspace.create"]?.channel).toBe("api:workspace:create");
    expect(API_SERVER_MAP["metadata.get"]?.channel).toBe("api:workspace:getMetadata");
    expect(API_SERVER_MAP["metadata.set"]?.channel).toBe("api:workspace:setMetadata");
    expect(API_SERVER_MAP["agent.session"]?.channel).toBe("api:workspace:getAgentSession");
    expect(API_SERVER_MAP["agent.restart"]?.channel).toBe("api:workspace:restartAgentServer");
    expect(API_SERVER_MAP["agent.lifecycle"]?.channel).toBe("api:workspace:agentLifecycle");
    expect(API_SERVER_MAP["vscode.command"]?.channel).toBe("api:workspace:executeCommand");
    expect(API_SERVER_MAP["system.open"]?.channel).toBe("api:workspace:openSystemPath");
    expect(API_SERVER_MAP["log"]?.channel).toBe("api:log");
    expect(API_SERVER_MAP["config.set"]?.channel).toBe("api:config:set");
  });

  it("keeps the two fire-and-forget channels fire-and-forget", () => {
    // Both predate the registry and the sidekick emits them without an ack.
    const noAck = Object.entries(API_SERVER_MAP)
      .filter(([, m]) => m?.fireAndForget)
      .map(([name]) => name)
      .sort();
    expect(noAck).toEqual(["agent.lifecycle", "log"]);
  });
});
