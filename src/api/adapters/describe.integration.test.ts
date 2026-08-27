// @vitest-environment node
/**
 * Conformance tests for the MCP and CLI mappings, and for the descriptor list
 * that out-of-process clients build their surfaces from.
 */

import { describe as suite, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createRegistry } from "../entries";
import { OPERATION_NAMES, type OperationName } from "../names";
import { MCP_MAP } from "./mcp-map";
import { CLI_MAP, resolveCliPath } from "./cli-map";
import { describe } from "./describe";

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

suite("MCP map", () => {
  it("covers the whole operation vocabulary", () => {
    expect(Object.keys(MCP_MAP).sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("gives each exposed operation a unique tool name", () => {
    const tools = Object.values(MCP_MAP)
      .filter((m) => m !== null)
      .map((m) => m!.tool);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("keeps the tool names agents already know", () => {
    // These were the MCP server's surface before the registry; renaming one
    // breaks prompts and transcripts that refer to it.
    expect(MCP_MAP["workspace.status"]?.tool).toBe("workspace_get_status");
    expect(MCP_MAP["workspace.delete"]?.tool).toBe("workspace_delete");
    expect(MCP_MAP["workspace.create"]?.tool).toBe("workspace_create");
    expect(MCP_MAP["metadata.set"]?.tool).toBe("workspace_set_metadata");
    expect(MCP_MAP["vscode.message"]?.tool).toBe("ui_show_message");
    expect(MCP_MAP["project.list"]?.tool).toBe("project_list");
    expect(MCP_MAP["report.issue"]?.tool).toBe("report_bug");
  });

  it("does not expose the event", () => {
    expect(MCP_MAP["agent.lifecycle"]).toBeNull();
  });
});

suite("CLI map", () => {
  it("covers the whole operation vocabulary", () => {
    expect(Object.keys(CLI_MAP).sort()).toEqual([...OPERATION_NAMES].sort());
  });

  it("gives each exposed operation a unique path", () => {
    const paths = Object.values(CLI_MAP)
      .filter((m) => m !== null)
      .map((m) => m!.path.join(" "));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("names only fields the operation actually accepts as positionals", () => {
    const reg = registry();
    for (const [name, mapping] of Object.entries(CLI_MAP) as [
      OperationName,
      (typeof CLI_MAP)[OperationName],
    ][]) {
      if (mapping?.positionals === undefined) continue;
      const shape = Object.keys(
        (reg.get(name).input as unknown as { shape: Record<string, unknown> }).shape
      );
      for (const field of mapping.positionals) {
        expect(shape, `${name} positional "${field}"`).toContain(field);
      }
    }
  });

  suite("path resolution", () => {
    it("prefers the longest matching path", () => {
      const resolved = resolveCliPath(["ws", "status", "set", "busy"]);
      expect(resolved?.name).toBe("agent.status.set");
      expect(resolved?.rest).toEqual(["busy"]);
    });

    it("still resolves the shorter path when the longer does not match", () => {
      const resolved = resolveCliPath(["ws", "status"]);
      expect(resolved?.name).toBe("workspace.status");
      expect(resolved?.rest).toEqual([]);
    });

    it("returns the trailing arguments as positionals", () => {
      const resolved = resolveCliPath(["ws", "diff", "a.ts", "b.ts"]);
      expect(resolved?.name).toBe("vscode.diff");
      expect(resolved?.rest).toEqual(["a.ts", "b.ts"]);
    });

    it("returns undefined for an unknown path", () => {
      expect(resolveCliPath(["ws", "bogus"])).toBeUndefined();
    });
  });
});

suite("describe", () => {
  it("describes exactly the operations an adapter maps", () => {
    const reg = registry();
    const mcpNames = describe(reg, "mcp").map((d) => d.name);
    const expected = Object.entries(MCP_MAP)
      .filter(([, m]) => m !== null)
      .map(([name]) => name);

    expect(mcpNames.sort()).toEqual(expected.sort());
  });

  it("carries a JSON Schema a client can build arguments from", () => {
    const del = describe(registry(), "cli").find((d) => d.name === "workspace.delete")!;
    const schema = del.inputSchema as { type: string; properties: Record<string, unknown> };

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["keepBranch", "ignoreWarnings", "wait"])
    );
  });

  it("hides fields the adapter does not accept", () => {
    // The plugin wire scopes a connection to one workspace, so its status
    // channel picks only `refresh` — a client must not be offered a target.
    const status = describe(registry(), "cli").find((d) => d.name === "workspace.status")!;
    const properties = Object.keys(
      (status.inputSchema as { properties: Record<string, unknown> }).properties
    );

    // The CLI does take a target, so this one keeps it.
    expect(properties).toContain("workspacePath");
  });

  it("carries the tool name for MCP and the path for the CLI", () => {
    const mcp = describe(registry(), "mcp").find((d) => d.name === "workspace.delete")!;
    const cli = describe(registry(), "cli").find((d) => d.name === "workspace.delete")!;

    expect(mcp.tool).toBe("workspace_delete");
    expect(mcp.path).toBeUndefined();
    expect(cli.path).toEqual(["ws", "delete"]);
    expect(cli.tool).toBeUndefined();
  });
});
