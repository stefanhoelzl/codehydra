import { describe, it, expect } from "vitest";
import { prependPath } from "./env-path";

describe("prependPath", () => {
  it("prepends with ':' on POSIX", () => {
    expect(prependPath({ PATH: "/usr/bin" }, "/bin-dir", "linux")).toEqual({
      PATH: "/bin-dir:/usr/bin",
    });
  });

  it("keeps the existing key's spelling and uses ';' on Windows", () => {
    expect(prependPath({ Path: "C:\\Windows" }, "C:\\bin", "win32")).toEqual({
      Path: "C:\\bin;C:\\Windows",
    });
  });

  it("drops a second spelling so the prefixed copy wins", () => {
    expect(prependPath({ Path: "C:\\a", PATH: "C:\\b" }, "C:\\bin", "win32")).toEqual({
      Path: "C:\\bin;C:\\a",
    });
  });

  it("sets PATH to the directory when there is none", () => {
    expect(prependPath({ HOME: "/home/u" }, "/bin-dir", "linux")).toEqual({
      HOME: "/home/u",
      PATH: "/bin-dir",
    });
  });

  it("does not mutate its input", () => {
    const env = { PATH: "/usr/bin" };
    prependPath(env, "/bin-dir", "linux");
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});
