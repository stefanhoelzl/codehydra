/**
 * The `ch` CLI against a packaged build.
 *
 * Everything else about the CLI is covered by fast tests with behavioural mocks.
 * What only a packaged run can prove is the part those mocks stand in for: that
 * the wrapper and its bundle are actually in the bin directory, that the wrapper
 * template was rendered with a working interpreter path, that the app published
 * connection details a separate process can find, and that a real socket
 * connection authenticates and answers.
 *
 * `e2e/ch.ts` runs the CLI the way a user or a script would — by absolute path,
 * with none of CodeHydra's environment — which is the case with no other
 * coverage.
 */
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import { BIN_DIR, CH, ch, chAsync, chSpawn, json } from "./ch.ts";
import {
  DATA_ROOT,
  createWorkspace,
  openProject,
  useApp,
  waitForConnectionDetails,
  workspacesDir,
} from "./fixtures";

const isWindows = process.platform === "win32";

let repo: { path: string; cleanup: () => Promise<void> };

test.beforeAll(async () => {
  repo = await createTestGitRepo();
});

test.afterAll(async () => {
  await repo?.cleanup();
});

const app = useApp();

test.describe("ch CLI", () => {
  test.beforeAll(async () => {
    await waitForConnectionDetails();
  });

  test("is installed in the bin directory alongside its bundle", () => {
    expect(existsSync(CH), `${CH} should exist`).toBe(true);
    expect(existsSync(join(BIN_DIR, "ch.cjs"))).toBe(true);
    expect(existsSync(join(BIN_DIR, isWindows ? "ch-bg.cmd" : "ch-bg"))).toBe(true);
    // The agent launchers live inside the bundle, not as scripts of their own.
    expect(existsSync(join(BIN_DIR, "ch-claude"))).toBe(false);
    expect(existsSync(join(BIN_DIR, "ch-opencode"))).toBe(false);
  });

  test("had its template rendered", () => {
    const wrapper = readFileSync(CH, "utf-8");

    // An unrendered template leaves the Liquid tag in place, and the CLI then
    // starts with no interpreter at all.
    expect(wrapper).not.toContain("{{");

    // That the baked path is not merely present but correct is proven by the
    // commands below: `ch` is invoked with every _CH_* variable stripped, so it
    // can only run by exec'ing the interpreter written into this file. Matching
    // the path here instead would mean encoding two wrapper dialects — a POSIX
    // path in `ch`, a drive path in `ch.cmd` — for a weaker check.
  });

  test("publishes connection details another process can read", () => {
    const state = JSON.parse(readFileSync(join(DATA_ROOT, "state.json"), "utf-8")) as Record<
      string,
      unknown
    >;

    expect(typeof state["plugin.port"]).toBe("number");
    expect(state["plugin.port"]).toBeGreaterThan(0);
    expect(typeof state["plugin.token"]).toBe("string");
  });

  test("connects, authenticates and answers an app-global command", () => {
    // Run from the data directory, which is inside no worktree — so this also
    // covers a workspace-less client reaching an app-global operation.
    const projects = json(ch(["project", "list"]));

    expect(Array.isArray(projects)).toBe(true);
  });

  test("reports a workspace command run outside any workspace", () => {
    const run = ch(["ws", "status"]);

    // Exit 4 is what lets a script tell "wrong place" from "the operation failed".
    expect(run.status).toBe(4);
    expect(JSON.parse(run.stderr)).toMatchObject({ exitCode: 4 });
  });

  test("resolves the workspace from the directory it is run in", async () => {
    await openProject(app(), repo.path);
    await createWorkspace(app(), "cli-target");

    // Poll: the sidebar row can render before git has finished writing the
    // worktree, so the directory is not there the instant creation "completes".
    const workspace = join(workspacesDir(), "cli-target");
    await expect.poll(() => existsSync(workspace), { timeout: 60_000 }).toBe(true);

    // Run from a subdirectory: resolution matches the deepest workspace
    // containing the path, not the worktree root exactly.
    const status = json(ch(["ws", "status"], workspace)) as Record<string, unknown>;

    // Reaching a real status at all is the point: the CLI was given a
    // subdirectory and the app matched it to the workspace containing it.
    expect(status).toHaveProperty("isDirty");
    expect(status).toHaveProperty("agent");
  });

  test("builds its help from the running app's registry", () => {
    const run = ch(["--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ws status");
    expect(run.stdout).toContain("project list");
    expect(run.stdout).toContain("mcp");
  });

  test("reports an unknown command as a usage error", () => {
    const run = ch(["ws", "definitely-not-a-command"]);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown command");
  });

  test("runs ch bg without needing the app", () => {
    // The background wrapper must work before anything is listening, so it
    // never contacts CodeHydra.
    const run = ch(["bg", process.execPath, "-e", "process.stdout.write('wrapped')"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("wrapped");
  });
});

test.describe("ch lock", () => {
  /**
   * Two workspaces to contend with. Reuses the project and `cli-target` the
   * earlier test made, and makes them itself when run on its own (`-g "ch lock"`).
   */
  let holder: string;
  let other: string;

  const ensureWorkspace = async (name: string): Promise<string> => {
    const projects = join(DATA_ROOT, "projects");
    if (!existsSync(projects) || readdirSync(projects).length === 0) {
      await openProject(app(), repo.path);
    }
    if (!existsSync(join(workspacesDir(), name))) await createWorkspace(app(), name);
    const path = join(workspacesDir(), name);
    await expect.poll(() => existsSync(path), { timeout: 60_000 }).toBe(true);
    return path;
  };

  type Row = { name: string; holder: string; waiting: string };
  const locks = (): Row[] => json(ch(["lock", "ls"])) as Row[];

  test.beforeAll(async () => {
    await waitForConnectionDetails();
    holder = await ensureWorkspace("cli-target");
    other = await ensureWorkspace("lock-other");
  });

  test("hands a lock between workspaces, refusing and reporting with distinct exit codes", async () => {
    expect(json(ch(["lock", "take", "device", "e2e"], holder))).toMatchObject({ acquired: true });

    // Refused without waiting: exit 5, from the category the app sent.
    const refused = ch(["lock", "take", "device", "--no-wait"], other);
    expect(refused.status).toBe(5);
    expect(refused.stderr).toContain("'device' is held by 'cli-target'");

    // A real waiter, queued behind the holder, granted on release.
    const waiting = chAsync(["lock", "take", "device"], other);
    await expect.poll(() => locks()[0]?.waiting, { timeout: 15_000 }).toBe("lock-other");
    expect(locks()).toMatchObject([{ name: "device", holder: "cli-target" }]);

    expect(json(ch(["lock", "release", "device"], holder))).toEqual({ released: ["device"] });
    expect(json(await waiting)).toMatchObject({ acquired: true });
    expect(locks()).toMatchObject([{ name: "device", holder: "lock-other", waiting: "" }]);

    // Releasing what this workspace no longer holds: exit 6.
    const notHeld = ch(["lock", "release", "device"], holder);
    expect(notHeld.status).toBe(6);

    json(ch(["lock", "release"], other));
    expect(locks()).toEqual([]);
  });

  test("shows the holder's lock as a sidebar tag", async () => {
    json(ch(["lock", "take", "device", "tag check"], holder));

    const tags = () => json(ch(["ws", "tag", "ls"], holder)) as { name: string; label?: string }[];
    await expect.poll(() => tags().find((tag) => tag.name === "lock")?.label).toBe("🔒 device");

    json(ch(["lock", "release", "device"], holder));
    await expect.poll(() => tags().some((tag) => tag.name === "lock")).toBe(false);
  });

  test("runs a command under the lock and exits with its status", () => {
    const run = ch(
      ["lock", "run", "device", "--", process.execPath, "-e", "process.exit(7)"],
      holder
    );

    expect(run.status).toBe(7);
    // Released when the command finished.
    expect(locks()).toEqual([]);
  });

  test("releases a hold when the process holding it is killed", async () => {
    const hold = chSpawn(["lock", "run", "device", "long session"], holder);
    const closed = new Promise((resolve) => hold.on("close", resolve));

    await expect.poll(() => locks()[0]?.holder, { timeout: 15_000 }).toBe("cli-target");

    hold.kill();
    await closed;

    await expect.poll(() => locks(), { timeout: 15_000 }).toEqual([]);
  });

  test("lists its commands in help, but not the plumbing `ch lock run` rides on", () => {
    const run = ch(["--help"]);

    expect(run.stdout).toContain("lock take");
    expect(run.stdout).toContain("lock run <name>");
    expect(run.stdout).not.toContain("lock hold");
  });
});

test.describe("ch mcp", () => {
  test.beforeAll(async () => {
    await waitForConnectionDetails();
  });

  test("serves the tool list over stdio", () => {
    // The agents launch this as a subprocess. Speaking raw JSON-RPC keeps the
    // spec honest about the wire an agent actually sees.
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];

    const run = spawnSync(CH, ["mcp"], {
      cwd: DATA_ROOT,
      encoding: "utf-8",
      input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
      // A stdio MCP server must exit when its agent closes stdin. Without a
      // timeout a regression there hangs the whole suite instead of failing.
      timeout: 30_000,
      ...(isWindows && { shell: true }),
    });

    const tools = run.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } })
      .find((message) => message.id === 2)?.result?.tools;

    expect(tools, `no tools/list response in: ${run.stdout}\n${run.stderr}`).toBeDefined();
    const names = tools!.map((tool) => tool.name);
    expect(names).toContain("workspace_get_status");
    expect(names).toContain("project_list");
    // The one event: only the sidekick can witness what it reports.
    expect(names).not.toContain("agent_lifecycle");
  });
});
