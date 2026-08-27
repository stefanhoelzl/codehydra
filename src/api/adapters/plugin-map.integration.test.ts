// @vitest-environment node
/**
 * Conformance tests for the plugin wire's mapping.
 *
 * The Record type already makes a missing operation a compile error. These cover
 * what the type cannot: that the names resolve to real entries, that no two
 * operations claim the same channel, and that the published channel names have
 * not moved — third-party extensions call these by name.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createRegistry } from "../entries";
import { OPERATION_NAMES, type OperationName } from "../names";
import { PLUGIN_MAP } from "./plugin-map";

function registry() {
  return createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
    },
    SILENT_LOGGER
  );
}

describe("plugin map", () => {
  it("covers the whole operation vocabulary", () => {
    expect(Object.keys(PLUGIN_MAP).sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("names only operations the registry actually implements", () => {
    const reg = registry();
    for (const name of Object.keys(PLUGIN_MAP) as OperationName[]) {
      expect(() => reg.get(name), name).not.toThrow();
    }
  });

  it("gives each carried operation a unique channel", () => {
    const channels = Object.values(PLUGIN_MAP)
      .filter((m) => m !== null)
      .map((m) => m!.channel);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps the published channel names stable", () => {
    // docs/API.md documents these for third-party extensions; renaming one is a
    // breaking change to the Public API, not a refactor.
    expect(PLUGIN_MAP["workspace.status"]?.channel).toBe("api:workspace:getStatus");
    expect(PLUGIN_MAP["workspace.delete"]?.channel).toBe("api:workspace:delete");
    expect(PLUGIN_MAP["workspace.create"]?.channel).toBe("api:workspace:create");
    expect(PLUGIN_MAP["metadata.get"]?.channel).toBe("api:workspace:getMetadata");
    expect(PLUGIN_MAP["metadata.set"]?.channel).toBe("api:workspace:setMetadata");
    expect(PLUGIN_MAP["agent.session"]?.channel).toBe("api:workspace:getAgentSession");
    expect(PLUGIN_MAP["agent.restart"]?.channel).toBe("api:workspace:restartAgentServer");
    expect(PLUGIN_MAP["agent.lifecycle"]?.channel).toBe("api:workspace:agentLifecycle");
    expect(PLUGIN_MAP["vscode.command"]?.channel).toBe("api:workspace:executeCommand");
    expect(PLUGIN_MAP["system.open"]?.channel).toBe("api:workspace:openSystemPath");
    expect(PLUGIN_MAP["log"]?.channel).toBe("api:log");
  });

  it("keeps the two fire-and-forget channels fire-and-forget", () => {
    // Both predate the registry and the sidekick emits them without an ack.
    const noAck = Object.entries(PLUGIN_MAP)
      .filter(([, m]) => m?.fireAndForget)
      .map(([name]) => name)
      .sort();
    expect(noAck).toEqual(["agent.lifecycle", "log"]);
  });
});
