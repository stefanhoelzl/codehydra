/**
 * Focused tests for buildServeEnv: the IDE server's spawn environment.
 */

import { describe, it, expect } from "vitest";
import { buildServeEnv, type ServeEnvInput } from "./serve-env";
import { createVscodiumIdeServer } from "./vscodium";
import type { IdeServer } from "./types";
import { Path } from "../../utils/path/path";
import { testPath } from "../../shared/test-fixtures";

const binDir = testPath("data", "bin");

function input(overrides?: Partial<ServeEnvInput>): ServeEnvInput {
  return {
    env: { PATH: "/usr/bin", HOME: "/home/user" },
    binDir,
    platform: "linux",
    ide: createVscodiumIdeServer(),
    ideServerDir: "/bundles/vscodium",
    apiPort: undefined,
    ...overrides,
  };
}

describe("buildServeEnv", () => {
  it("drops VSCODE_* variables and keeps the rest", () => {
    const env = buildServeEnv(
      input({ env: { PATH: "/usr/bin", HOME: "/home/user", VSCODE_PID: "1", VSCODE_IPC: "x" } })
    );

    expect(env.HOME).toBe("/home/user");
    expect(Object.keys(env).filter((key) => key.startsWith("VSCODE_"))).toEqual([]);
  });

  it("puts the bin dir first on PATH with the target platform's delimiter", () => {
    expect(buildServeEnv(input()).PATH).toBe(`${binDir.toNative()}:/usr/bin`);

    const windows = buildServeEnv(
      input({ platform: "win32", env: { Path: "C:\\Windows\\System32" } })
    );
    // The existing spelling is kept, so no second PATH can shadow it.
    expect(windows.Path).toBe(`${binDir.toNative()};C:\\Windows\\System32`);
    expect(windows.PATH).toBeUndefined();
  });

  it("makes the code wrapper the editor, quoted on Windows", () => {
    const posix = buildServeEnv(input());
    const posixCode = new Path(binDir, "code").toNative();
    expect(posix.EDITOR).toBe(`${posixCode} --wait --reuse-window`);
    expect(posix.GIT_SEQUENCE_EDITOR).toBe(posix.EDITOR);

    const windows = buildServeEnv(input({ platform: "win32" }));
    const windowsCode = new Path(binDir, "code.cmd").toNative();
    expect(windows.EDITOR).toBe(`"${windowsCode}" --wait --reuse-window`);
  });

  it("sets the API port only when the API server runs", () => {
    expect(buildServeEnv(input())._CH_API_PORT).toBeUndefined();
    expect(buildServeEnv(input({ apiPort: 4242 }))._CH_API_PORT).toBe("4242");
  });

  it("carries the distribution's env and its remote CLI and node", () => {
    const base = createVscodiumIdeServer();
    const ide: IdeServer = {
      ...base,
      serveEnv: () => ({ DIST_FLAG: "1" }),
      remoteCli: () => ({ exe: "C:\\ide\\cli.cmd", args: ["--a", "b c"] }),
    };

    const env = buildServeEnv(input({ ide, platform: "win32", ideServerDir: "C:\\ide" }));

    expect(env.DIST_FLAG).toBe("1");
    expect(env._CH_IDE_REMOTE_CLI).toBe("C:\\ide\\cli.cmd");
    expect(env._CH_IDE_REMOTE_CLI_ARGS).toBe('"--a" "b c"');
    expect(env._CH_IDE_NODE).toBe("C:\\ide\\node.exe");
  });

  it("passes remote CLI arguments through unquoted on POSIX", () => {
    const base = createVscodiumIdeServer();
    const ide: IdeServer = { ...base, remoteCli: () => ({ exe: "/ide/cli", args: ["--a", "b"] }) };

    expect(buildServeEnv(input({ ide }))._CH_IDE_REMOTE_CLI_ARGS).toBe("--a b");
  });
});
