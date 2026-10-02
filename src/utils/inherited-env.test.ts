import { describe, it, expect } from "vitest";
import { clearInheritedEnv } from "./inherited-env";

describe("clearInheritedEnv", () => {
  it("removes every _CH_ variable and names them", () => {
    const env: NodeJS.ProcessEnv = {
      _CH_API_PORT: "42347",
      _CH_API_TOKEN: "secret",
      _CH_DATA_DIR: "/data",
      _CH_ROOT_DIR: "/root",
      PATH: "/usr/bin",
    };

    expect(clearInheritedEnv(env).sort()).toEqual([
      "_CH_API_PORT",
      "_CH_API_TOKEN",
      "_CH_DATA_DIR",
      "_CH_ROOT_DIR",
    ]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps config variables and development-build inputs", () => {
    const env: NodeJS.ProcessEnv = {
      CH_LOG__LEVEL: "debug",
      _CHDEV_ROOT_DIR: "/tmp/root",
    };

    expect(clearInheritedEnv(env)).toEqual([]);
    expect(env).toEqual({ CH_LOG__LEVEL: "debug", _CHDEV_ROOT_DIR: "/tmp/root" });
  });
});
