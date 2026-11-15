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
  SESSION_FILE,
  type DiscoveryFs,
  type IsProcessAlive,
} from "./discovery";

/** The one process the tests treat as running. */
const LIVE_PID = 1000;
const isAlive: IsProcessAlive = (pid) => pid === LIVE_PID;

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
  const sessionPath = join("/data", SESSION_FILE);
  const session = (fields: Record<string, unknown>) => ({
    [sessionPath]: JSON.stringify({ port: 45123, token: "secret", pid: LIVE_PID, ...fields }),
  });

  it("reads the port and token the instance published", () => {
    expect(readConnection("/data", fakeFs(session({})), isAlive)).toEqual({
      port: 45123,
      token: "secret",
      dataDir: "/data",
    });
  });

  it("does not look in state.json, where earlier releases published them", () => {
    const fs = fakeFs({
      [join("/data", "state.json")]: JSON.stringify({ "api.port": 1, "api.token": "t" }),
    });

    expect(() => readConnection("/data", fs, isAlive)).toThrow(/not appear to be running/);
  });

  it("reports a missing file as CodeHydra not running", () => {
    expect(() => readConnection("/data", fakeFs({}), isAlive)).toThrow(DiscoveryError);
    expect(() => readConnection("/data", fakeFs({}), isAlive)).toThrow(/not appear to be running/);
  });

  it("reports a file left by a launch that has exited as not running", () => {
    // A crash skips the shutdown that deletes the file; its port may belong
    // to anyone now, and must not be handed this token.
    const fs = fakeFs(session({ pid: LIVE_PID + 1 }));

    expect(() => readConnection("/data", fs, isAlive)).toThrow(/process that has exited/);
  });

  it("names the file when its contents are not JSON", () => {
    const fs = fakeFs({ [sessionPath]: "{ truncated" });

    expect(() => readConnection("/data", fs, isAlive)).toThrow(/not valid JSON/);
  });

  it.each([
    ["a zero port", { port: 0 }],
    ["an empty token", { token: "" }],
    ["no pid", { pid: undefined }],
  ])("rejects %s rather than attempting a connection", (_name, fields) => {
    expect(() => readConnection("/data", fakeFs(session(fields)), isAlive)).toThrow(
      /no connection details/
    );
  });
});

describe("chooseConnection", () => {
  const SELF = "/self/bin/ch.cjs";
  const session = (dir: string, port: number) => ({
    [join(dir, SESSION_FILE)]: JSON.stringify({ port, token: `token-${port}`, pid: LIVE_PID }),
  });
  const inherited = { _CH_API_PORT: "41000", _CH_API_TOKEN: "from-env" };

  it("uses the port and token it was handed, so ch mcp needs no session file", () => {
    expect(chooseConnection(SELF, inherited, fakeFs({}), isAlive)).toEqual({
      port: 41000,
      token: "from-env",
      dataDir: "/self",
    });
  });

  it("lets _CH_DATA_DIR beat the port and token it inherited", () => {
    const fs = fakeFs({ ...session("/data", 42000), ...session("/self", 43000) });

    expect(chooseConnection(SELF, { ...inherited, _CH_DATA_DIR: "/data" }, fs, isAlive)).toEqual({
      port: 42000,
      token: "token-42000",
      dataDir: "/data",
    });
  });

  it("falls back to its own data directory when the environment names nothing usable", () => {
    const fs = fakeFs(session("/self", 43000));

    expect(
      chooseConnection(SELF, { _CH_API_PORT: "41000", _CH_DATA_DIR: "" }, fs, isAlive)
    ).toEqual({
      port: 43000,
      token: "token-43000",
      dataDir: "/self",
    });
  });
});
