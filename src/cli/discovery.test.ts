/**
 * Focused tests for instance discovery.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  chooseConnection,
  DiscoveryError,
  readConnection,
  resolveDataDir,
  STATE_PORT_KEY,
  STATE_TOKEN_KEY,
  type DiscoveryFs,
} from "./discovery";

function fakeFs(files: Record<string, string>, links: Record<string, string> = {}): DiscoveryFs {
  return {
    readFileSync: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    realpathSync: (path) => links[path] ?? path,
  };
}

describe("resolveDataDir", () => {
  it("takes the data directory two levels above the binary", () => {
    expect(resolveDataDir("/data/bin/ch.cjs", fakeFs({}))).toBe("/data");
  });

  it("follows a symlink so a shim on PATH finds the instance that installed it", () => {
    const fs = fakeFs({}, { "/home/me/.local/bin/ch": "/data/bin/ch.cjs" });

    expect(resolveDataDir("/home/me/.local/bin/ch", fs)).toBe("/data");
  });

  it("falls back to the unresolved path when realpath fails", () => {
    const fs: DiscoveryFs = {
      readFileSync: () => "",
      realpathSync: () => {
        throw new Error("EACCES");
      },
    };

    expect(resolveDataDir("/data/bin/ch.cjs", fs)).toBe("/data");
  });

  it("prefers an explicit override, so another instance can be targeted", () => {
    expect(resolveDataDir("/data/bin/ch.cjs", fakeFs({}), "/other")).toBe("/other");
  });
});

describe("readConnection", () => {
  const statePath = join("/data", "state.json");

  it("reads the port and token the instance published", () => {
    const fs = fakeFs({
      [statePath]: JSON.stringify({ [STATE_PORT_KEY]: 45123, [STATE_TOKEN_KEY]: "secret" }),
    });

    expect(readConnection("/data", fs)).toEqual({
      port: 45123,
      token: "secret",
      dataDir: "/data",
    });
  });

  it("ignores unrelated state keys", () => {
    const fs = fakeFs({
      [statePath]: JSON.stringify({
        "telemetry.distinct-id": "abc",
        [STATE_PORT_KEY]: 1,
        [STATE_TOKEN_KEY]: "t",
      }),
    });

    expect(readConnection("/data", fs).port).toBe(1);
  });

  it("reports a missing file as CodeHydra not running", () => {
    expect(() => readConnection("/data", fakeFs({}))).toThrow(DiscoveryError);
    expect(() => readConnection("/data", fakeFs({}))).toThrow(/not appear to be running/);
  });

  it("reports connection details missing from an otherwise valid file", () => {
    // A state file exists from a previous version, or the app is mid-startup.
    const fs = fakeFs({ [statePath]: JSON.stringify({ "telemetry.distinct-id": "abc" }) });

    expect(() => readConnection("/data", fs)).toThrow(/no connection details/);
  });

  it("names the file when its contents are not JSON", () => {
    const fs = fakeFs({ [statePath]: "{ truncated" });

    expect(() => readConnection("/data", fs)).toThrow(/not valid JSON/);
  });

  it("treats a zero port as not running", () => {
    // The app writes 0 when the plugin server failed to start.
    const fs = fakeFs({
      [statePath]: JSON.stringify({ [STATE_PORT_KEY]: 0, [STATE_TOKEN_KEY]: "t" }),
    });

    expect(() => readConnection("/data", fs)).toThrow(/no connection details/);
  });

  it("rejects an empty token rather than attempting an unauthenticated connection", () => {
    const fs = fakeFs({
      [statePath]: JSON.stringify({ [STATE_PORT_KEY]: 1, [STATE_TOKEN_KEY]: "" }),
    });

    expect(() => readConnection("/data", fs)).toThrow(/no connection details/);
  });
});

describe("chooseConnection", () => {
  const SELF = "/self/bin/ch.cjs";
  const state = (dir: string, port: number) => ({
    [join(dir, "state.json")]: JSON.stringify({
      [STATE_PORT_KEY]: port,
      [STATE_TOKEN_KEY]: `token-${port}`,
    }),
  });
  const inherited = { _CH_PLUGIN_PORT: "41000", _CH_PLUGIN_TOKEN: "from-env" };

  it("uses the port and token it was handed, so ch mcp needs no state file", () => {
    expect(chooseConnection(SELF, inherited, fakeFs({}))).toEqual({
      port: 41000,
      token: "from-env",
      dataDir: "/self",
    });
  });

  it("lets _CH_DATA_DIR beat the port and token it inherited", () => {
    const fs = fakeFs({ ...state("/data", 42000), ...state("/self", 43000) });

    expect(chooseConnection(SELF, { ...inherited, _CH_DATA_DIR: "/data" }, fs)).toEqual({
      port: 42000,
      token: "token-42000",
      dataDir: "/data",
    });
  });

  it("falls back to its own data directory when the environment names nothing usable", () => {
    const fs = fakeFs(state("/self", 43000));

    expect(chooseConnection(SELF, { _CH_PLUGIN_PORT: "41000", _CH_DATA_DIR: "" }, fs)).toEqual({
      port: 43000,
      token: "token-43000",
      dataDir: "/self",
    });
  });
});
