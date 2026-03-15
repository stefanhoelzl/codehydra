// @vitest-environment node
/**
 * Integration tests for ConfigService.
 *
 * Covers:
 * - register() / load() / get() / set() lifecycle
 * - Precedence: CLI > env > file > computed defaults > static defaults
 * - Validation errors for unknown keys and invalid values
 * - Sync load from config.json via readFileSync
 * - Async set() persistence via FileSystemLayer
 * - parseEnvVars / parseCliArgs standalone
 */

import { describe, it, expect, vi } from "vitest";
import { Path } from "../platform/path";
import { SILENT_LOGGER } from "../logging";
import { createFileSystemMock, file, directory } from "../platform/filesystem.state-mock";
import { DefaultConfigService, parseEnvVars, parseCliArgs } from "./config-service";
import type { ConfigService, ConfigServiceDeps } from "./config-service";
import type { ConfigKeyDefinition } from "./config-definition";
import { parseBool, ConfigValidationError } from "./config-definition";

// =============================================================================
// Test Config Definitions
// =============================================================================

function stringDef(name: string, defaultValue = "default"): ConfigKeyDefinition<unknown> {
  return {
    name,
    default: defaultValue,
    parse: (s: string) => (s === "" ? undefined : s),
    validate: (v: unknown) => (typeof v === "string" ? v : undefined),
  };
}

function boolDef(name: string, defaultValue = false): ConfigKeyDefinition<unknown> {
  return {
    name,
    default: defaultValue,
    parse: parseBool,
    validate: (v: unknown) => (typeof v === "boolean" ? v : undefined),
  };
}

function enumDef(
  name: string,
  values: string[],
  defaultValue: string | null = null
): ConfigKeyDefinition<unknown> {
  const set = new Set(values);
  return {
    name,
    default: defaultValue,
    parse: (s: string) => (set.has(s) ? s : s === "" ? null : undefined),
    validate: (v: unknown) =>
      v === null ? null : typeof v === "string" && set.has(v) ? v : undefined,
  };
}

// =============================================================================
// Helpers
// =============================================================================

const CONFIG_PATH = new Path("/app/config.json");

/**
 * Create a sync readFileSync from a mock FileSystemLayer.
 * Uses the mock's async readFile but wraps it for sync test usage.
 * In practice, the mock's entries are in-memory so we read them directly.
 */
function createSyncReader(
  entries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>
): (path: string) => string {
  return (path: string) => {
    const normalized = new Path(path).toString();
    const entry = entries[normalized];
    if (!entry || entry.type !== "file") {
      const err = new Error(`ENOENT: no such file: ${path}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return entry.content as string;
  };
}

function createDeps(overrides?: Partial<ConfigServiceDeps>): ConfigServiceDeps {
  return {
    configPath: CONFIG_PATH,
    fileSystem: createFileSystemMock({
      entries: {
        "/app": directory(),
      },
    }),
    logger: SILENT_LOGGER,
    isDevelopment: false,
    isPackaged: true,
    env: {},
    argv: [],
    readFileSync: () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    ...overrides,
  };
}

interface CreateServiceOptions extends Partial<ConfigServiceDeps> {
  fileEntries?: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>;
}

function createService(overrides?: CreateServiceOptions): ConfigService {
  if (overrides?.fileEntries) {
    const entries = overrides.fileEntries;
    const fs = createFileSystemMock({ entries });
    const { fileEntries: _unused, ...rest } = overrides;
    void _unused;
    return new DefaultConfigService(
      createDeps({
        fileSystem: fs,
        readFileSync: createSyncReader(entries),
        ...rest,
      })
    );
  }
  return new DefaultConfigService(createDeps(overrides));
}

// =============================================================================
// Tests
// =============================================================================

describe("ConfigService", () => {
  describe("register + load + get", () => {
    it("returns static defaults when no other sources exist", () => {
      const svc = createService();
      svc.register("test.key", stringDef("test.key", "hello"));
      svc.load();

      expect(svc.get("test.key")).toBe("hello");
    });

    it("applies computed defaults over static defaults", () => {
      const svc = createService({ isDevelopment: true });
      svc.register("test.key", {
        ...stringDef("test.key", "prod-default"),
        computedDefault: (ctx) => (ctx.isDevelopment ? "dev-default" : undefined),
      });
      svc.load();

      expect(svc.get("test.key")).toBe("dev-default");
    });

    it("reads values from config.json", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.key": "from-file" })),
        },
      });
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(svc.get("test.key")).toBe("from-file");
    });

    it("env vars override file values", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.key": "from-file" })),
        },
        env: { CH_TEST__KEY: "from-env" },
      });
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(svc.get("test.key")).toBe("from-env");
    });

    it("CLI flags override env vars", () => {
      const svc = createService({
        env: { CH_TEST__KEY: "from-env" },
        argv: ["--test.key=from-cli"],
      });
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(svc.get("test.key")).toBe("from-cli");
    });

    it("full precedence chain: CLI > env > file > computed > static", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(
            JSON.stringify({
              "test.a": "file-a",
              "test.b": "file-b",
              "test.c": "file-c",
              "test.d": "file-d",
            })
          ),
        },
        isDevelopment: true,
        env: { CH_TEST__B: "env-b", CH_TEST__C: "env-c" },
        argv: ["--test.c=cli-c"],
      });

      const computedDef: ConfigKeyDefinition<unknown> = {
        ...stringDef("test.d", "static-d"),
        computedDefault: () => "computed-d",
      };

      svc.register("test.a", stringDef("test.a", "static-a"));
      svc.register("test.b", stringDef("test.b", "static-b"));
      svc.register("test.c", stringDef("test.c", "static-c"));
      svc.register("test.d", computedDef);
      svc.load();

      expect(svc.get("test.a")).toBe("file-a"); // file wins over static
      expect(svc.get("test.b")).toBe("env-b"); // env wins over file
      expect(svc.get("test.c")).toBe("cli-c"); // CLI wins over env
      expect(svc.get("test.d")).toBe("file-d"); // file wins over computed
    });

    it("handles missing config.json gracefully", () => {
      const svc = createService(); // no file in mock fs
      svc.register("test.key", stringDef("test.key", "fallback"));
      svc.load();

      expect(svc.get("test.key")).toBe("fallback");
    });

    it("supports boolean CLI flags without value", () => {
      const svc = createService({ argv: ["--test.flag"] });
      svc.register("test.flag", boolDef("test.flag"));
      svc.load();

      expect(svc.get("test.flag")).toBe(true);
    });

    it("supports --key value CLI format", () => {
      const svc = createService({ argv: ["--test.key", "value"] });
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(svc.get("test.key")).toBe("value");
    });
  });

  describe("validation", () => {
    it("throws on unknown key in config.json", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "unknown.key": "value" })),
        },
      });
      svc.register("test.key", stringDef("test.key"));

      expect(() => svc.load()).toThrow(ConfigValidationError);
    });

    it("throws on invalid value in config.json", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.flag": "not-a-bool" })),
        },
      });
      svc.register("test.flag", boolDef("test.flag"));

      expect(() => svc.load()).toThrow(ConfigValidationError);
    });

    it("throws on invalid env var value", () => {
      const svc = createService({ env: { CH_TEST__FLAG: "invalid" } });
      svc.register("test.flag", boolDef("test.flag"));

      expect(() => svc.load()).toThrow(ConfigValidationError);
    });

    it("throws on get() with unregistered key", () => {
      const svc = createService();
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(() => svc.get("unknown.key")).toThrow('Unknown config key: "unknown.key"');
    });

    it("throws on duplicate register()", () => {
      const svc = createService();
      svc.register("test.key", stringDef("test.key"));

      expect(() => svc.register("test.key", stringDef("test.key"))).toThrow(
        'Duplicate config key definition: "test.key"'
      );
    });

    it("throws on register() after load()", () => {
      const svc = createService();
      svc.load();

      expect(() => svc.register("test.key", stringDef("test.key"))).toThrow(
        'Cannot register config key "test.key" after load()'
      );
    });

    it("throws on double load()", () => {
      const svc = createService();
      svc.load();

      expect(() => svc.load()).toThrow("ConfigService.load() has already been called");
    });
  });

  describe("set()", () => {
    it("updates effective value", async () => {
      const svc = createService();
      svc.register("test.key", stringDef("test.key", "initial"));
      svc.load();

      await svc.set("test.key", "updated");
      expect(svc.get("test.key")).toBe("updated");
    });

    it("persists to config.json by default", async () => {
      const fs = createFileSystemMock({
        entries: { "/app": directory() },
      });
      const svc = createService({ fileSystem: fs });
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      await svc.set("test.key", "persisted");

      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({ "test.key": "persisted" });
    });

    it("does not persist when persist=false", async () => {
      const fs = createFileSystemMock({
        entries: { "/app": directory() },
      });
      const svc = createService({ fileSystem: fs });
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      await svc.set("test.key", "memory-only", { persist: false });
      expect(svc.get("test.key")).toBe("memory-only");

      // Config file should not exist
      await expect(fs.readFile(CONFIG_PATH)).rejects.toThrow();
    });

    it("preserves existing file content on set", async () => {
      const entries = {
        "/app": directory(),
        "/app/config.json": file(JSON.stringify({ "test.a": "existing" })),
      };
      const fs = createFileSystemMock({ entries });
      const svc = new DefaultConfigService(
        createDeps({
          fileSystem: fs,
          readFileSync: createSyncReader(entries),
        })
      );
      svc.register("test.a", stringDef("test.a"));
      svc.register("test.b", stringDef("test.b"));
      svc.load();

      await svc.set("test.b", "new-value");

      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({ "test.a": "existing", "test.b": "new-value" });
    });

    it("removes key from file when set to null", async () => {
      const entries = {
        "/app": directory(),
        "/app/config.json": file(JSON.stringify({ "test.key": "value" })),
      };
      const fs = createFileSystemMock({ entries });
      const svc = new DefaultConfigService(
        createDeps({
          fileSystem: fs,
          readFileSync: createSyncReader(entries),
        })
      );
      svc.register("test.key", enumDef("test.key", ["value"], null));
      svc.load();

      await svc.set("test.key", null);

      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({});
    });

    it("throws on unknown key", async () => {
      const svc = createService();
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      await expect(svc.set("unknown.key", "value")).rejects.toThrow(ConfigValidationError);
    });

    it("throws on invalid value", async () => {
      const svc = createService();
      svc.register("test.flag", boolDef("test.flag"));
      svc.load();

      await expect(svc.set("test.flag", "not-bool")).rejects.toThrow(ConfigValidationError);
    });
  });

  describe("getDefinitions + getEffective", () => {
    it("returns all registered definitions", () => {
      const svc = createService();
      svc.register("test.a", stringDef("test.a"));
      svc.register("test.b", boolDef("test.b"));
      svc.load();

      const defs = svc.getDefinitions();
      expect(defs.size).toBe(2);
      expect(defs.has("test.a")).toBe(true);
      expect(defs.has("test.b")).toBe(true);
    });

    it("returns all effective values", () => {
      const svc = createService({ env: { CH_TEST__B: "true" } });
      svc.register("test.a", stringDef("test.a", "val-a"));
      svc.register("test.b", boolDef("test.b", false));
      svc.load();

      const effective = svc.getEffective();
      expect(effective["test.a"]).toBe("val-a");
      expect(effective["test.b"]).toBe(true);
    });
  });
});

// =============================================================================
// Standalone parser tests (moved from config-module tests)
// =============================================================================

describe("parseEnvVars", () => {
  const definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>> = new Map([
    ["test.key", stringDef("test.key")],
    ["test.flag", boolDef("test.flag")],
    ["test.dev-option", stringDef("test.dev-option")],
  ]);

  it("parses CH_* env vars to config keys", () => {
    const result = parseEnvVars({ CH_TEST__KEY: "hello", CH_TEST__FLAG: "true" }, definitions);
    expect(result).toEqual({ "test.key": "hello", "test.flag": true });
  });

  it("skips _CH_ prefixed vars", () => {
    const result = parseEnvVars({ _CH_TEST__KEY: "skip" }, definitions);
    expect(result).toEqual({});
  });

  it("handles kebab-case conversion (underscore → hyphen)", () => {
    const result = parseEnvVars({ CH_TEST__DEV_OPTION: "value" }, definitions);
    expect(result).toEqual({ "test.dev-option": "value" });
  });
});

describe("parseCliArgs", () => {
  const definitions: ReadonlyMap<string, ConfigKeyDefinition<unknown>> = new Map([
    ["test.key", stringDef("test.key")],
    ["test.flag", boolDef("test.flag")],
  ]);

  it("parses --key=value format", () => {
    const result = parseCliArgs(["--test.key=hello"], definitions, SILENT_LOGGER);
    expect(result).toEqual({ "test.key": "hello" });
  });

  it("parses --key value format", () => {
    const result = parseCliArgs(["--test.key", "hello"], definitions, SILENT_LOGGER);
    expect(result).toEqual({ "test.key": "hello" });
  });

  it("treats bare --flag as true", () => {
    const result = parseCliArgs(["--test.flag"], definitions, SILENT_LOGGER);
    expect(result).toEqual({ "test.flag": true });
  });

  it("skips unknown flags with warning", () => {
    const logger = { ...SILENT_LOGGER, warn: vi.fn() };
    const result = parseCliArgs(["--unknown-flag=val"], definitions, logger);
    expect(result).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith("Unknown CLI flag (ignored)", {
      flag: "unknown-flag",
    });
  });
});
