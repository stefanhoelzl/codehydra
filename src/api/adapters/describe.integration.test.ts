// @vitest-environment node
/**
 * Conformance tests for the MCP and CLI mappings, and for the descriptor list
 * that out-of-process clients build their surfaces from.
 */

import { describe as suite, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createLockModule } from "../../modules/lock-module";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createRegistry } from "../entries";
import { OPERATION_NAMES, type OperationName } from "../names";
import { MCP_MAP } from "./mcp-map";
import { CLI_MAP, resolveCliPath } from "./cli-map";
import { describe } from "./describe";
import { sealedProjectTypeOptions } from "../../intents/project-type-options";
import { GIT_PROJECT_OPTIONS } from "../../modules/git/options";
import { testProjectTypes } from "../../intents/project-type-options.test-utils";

function registry() {
  return createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      wakeups: { set: async () => {}, show: async () => null },
      processes: { list: async () => null },
      readUserGuide: async () => "",
      plugins: () => {
        throw new Error("this test reaches no plugins");
      },
      // What the app has once the git module answered register-project-types.
      projectTypes: sealedProjectTypeOptions(GIT_PROJECT_OPTIONS),
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

  it("offers every adapter the same fields, target included", () => {
    const properties = (target: "cli" | "mcp") =>
      Object.keys(
        (
          describe(registry(), target).find((d) => d.name === "workspace.status")!.inputSchema as {
            properties: Record<string, unknown>;
          }
        ).properties
      );

    // `--workspace` / `--project` on the command line, arguments of a tool.
    expect(properties("cli")).toEqual(["workspace", "project", "refresh"]);
    expect(properties("mcp")).toEqual(properties("cli"));
  });

  it("marks a field the adapter defaults as optional, and only for that adapter", () => {
    const required = (target: "cli" | "mcp") =>
      (
        describe(registry(), target).find((d) => d.name === "workspace.title")!.inputSchema as {
          required?: string[];
        }
      ).required ?? [];

    // `ch ws title` with no title clears it; an MCP caller passes null.
    expect(required("cli")).not.toContain("title");
    expect(required("mcp")).toContain("title");
  });

  it("carries the tool name for MCP and the path for the CLI", () => {
    const mcp = describe(registry(), "mcp").find((d) => d.name === "workspace.delete")!;
    const cli = describe(registry(), "cli").find((d) => d.name === "workspace.delete")!;

    expect(mcp.tool).toBe("workspace_delete");
    expect(mcp.path).toBeUndefined();
    expect(cli.path).toEqual(["ws", "delete"]);
    expect(cli.tool).toBeUndefined();
  });

  it("marks a hidden CLI command, and only that one", () => {
    const cli = describe(registry(), "cli");

    expect(cli.filter((d) => d.hidden === true).map((d) => d.name)).toEqual(["lock.hold"]);
  });
});

/**
 * What `ch ws create` / `ch ws delete` and the MCP tools took before project
 * types described their own options, recorded from that version. git's options
 * now come from its description (`modules/git/options.ts`); a script or agent
 * must see no difference.
 */
const GIT_CREATE_INPUT_BEFORE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    project: {
      description:
        "Project: an open project's name or ref, a local path, or a git URL. Opened (or cloned) if it is not open yet. Omit to use the caller's own project.",
      type: "string",
      minLength: 1,
    },
    name: {
      type: "string",
      minLength: 1,
      description: "Name for the new workspace (becomes the branch name)",
    },
    base: {
      description: "Base branch. Omit to use the project's default branch.",
      type: "string",
      minLength: 1,
    },
    tracking: {
      description: "Remote branch to check out, e.g. 'origin/feature-login'.",
      type: "string",
      minLength: 1,
    },
    prompt: { description: "Initial prompt to send once created.", type: "string", minLength: 1 },
    agent: {
      description: "Agent backend to launch: claude or opencode.",
      type: "string",
      minLength: 1,
    },
    model: {
      description:
        "Model for the initial prompt: 'provider/model' (opencode requires the provider; claude accepts a bare model id).",
      type: "string",
      minLength: 1,
    },
    permissionMode: {
      description: "Claude permission mode to start in, e.g. 'plan'. Requires agent=claude.",
      type: "string",
      minLength: 1,
    },
    agentName: {
      description: "Named agent (persona) to launch. Requires an agent backend.",
      type: "string",
      minLength: 1,
    },
    stealFocus: { default: false, description: "Switch to the new workspace.", type: "boolean" },
  },
  required: ["name"],
};

const GIT_DELETE_INPUT_BEFORE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    workspace: {
      description:
        "Workspace to act on: its name (looked up in your own project first), <project>::<name>, or its full ref (ch::…). Omit to target the current workspace.",
      type: "string",
      minLength: 1,
    },
    project: {
      description:
        "Project to look the workspace name up in: its name, path, git origin, <type>::<identifier> or full ref. Needs workspace.",
      type: "string",
      minLength: 1,
    },
    keepBranch: { default: false, type: "boolean" },
    ignoreWarnings: { default: false, type: "boolean" },
    wait: { default: true, type: "boolean" },
  },
};

suite("describe: git's options from its description", () => {
  for (const target of ["cli", "mcp"] as const) {
    it(`gives ${target} the create and delete inputs it always had, fields in order`, () => {
      const descriptors = describe(registry(), target);
      const create = descriptors.find((d) => d.name === "workspace.create")!;
      const remove = descriptors.find((d) => d.name === "workspace.delete")!;

      expect(create.inputSchema).toEqual(GIT_CREATE_INPUT_BEFORE);
      expect(remove.inputSchema).toEqual(GIT_DELETE_INPUT_BEFORE);
      expect(Object.keys((create.inputSchema as { properties: object }).properties)).toEqual(
        Object.keys(GIT_CREATE_INPUT_BEFORE.properties)
      );
    });
  }

  it("keeps `ch ws create <name> [base]`: the type's positional option follows name", () => {
    const create = describe(registry(), "cli").find((d) => d.name === "workspace.create")!;

    expect(create.positionals).toEqual(["name", "base"]);
    expect(CLI_MAP["workspace.create"]?.positionals).toEqual(["name"]);
  });

  it("adds another type's options beside git's, and its positional only when it has one", () => {
    const both = createRegistry(
      {
        dispatcher: createMockDispatcher(),
        appLayer: { openPath: async () => undefined },
        awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
        locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER })
          .locks,
        config: createMockConfig(),
        wakeups: { set: async () => {}, show: async () => null },
        processes: { list: async () => null },
        readUserGuide: async () => "",
        plugins: () => {
          throw new Error("this test reaches no plugins");
        },
        projectTypes: testProjectTypes(),
      },
      SILENT_LOGGER
    );
    const descriptors = describe(both, "mcp");
    const create = descriptors.find((d) => d.name === "workspace.create")!;
    const remove = descriptors.find((d) => d.name === "workspace.delete")!;

    expect((create.inputSchema as { properties: object }).properties).toMatchObject({
      template: { enum: ["empty", "readme"], default: "empty" },
    });
    expect((remove.inputSchema as { properties: object }).properties).toMatchObject({
      archive: { type: "boolean", default: false },
    });
    expect(remove.instructions).toMatch(/for git: uncommitted changes/);
    expect(remove.instructions).toMatch(/for fake: an archive that is not empty/);
  });
});
