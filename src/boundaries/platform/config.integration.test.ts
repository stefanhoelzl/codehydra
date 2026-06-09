// @vitest-environment node
/**
 * Integration tests for Config.
 *
 * Covers:
 * - register() / load() / accessor get/set/reset lifecycle
 * - Precedence: CLI > env > file > computed defaults > static defaults
 * - Lenient handling of unknown/deprecated/legacy keys across all sources
 * - Sync load from config.json via readFileSync
 * - Async accessor.set() persistence via FileSystemBoundary
 * - parseEnvVars / parseCliArgs standalone tokenizers
 */

import { describe, it, expect, vi } from "vitest";
import { Path } from "../../utils/path/path";
import { SILENT_LOGGER } from "./logging";
import { createFileSystemMock, file, directory } from "./filesystem.state-mock";
import { DefaultConfig, parseEnvVars, parseCliArgs } from "./config";
import type { Config, ConfigDeps } from "./config";
import type { ConfigKeyDefinition } from "./config-definition";
import { parseBool, ConfigValidationError } from "./config-definition";

// =============================================================================
// Test Config Definitions
// =============================================================================

/**
 * Non-deprecated definition shape accepted by `register()`'s first overload.
 * Helpers return this so the values flow through to a `ConfigAccessor`; the
 * deprecated tests spread one of these and override `deprecated: true` to hit
 * the second overload.
 */
type TestDef = Omit<ConfigKeyDefinition<unknown>, "deprecated">;

function stringDef(_name: string, defaultValue = "default"): TestDef {
  return {
    default: defaultValue,
    parse: (s: string) => (s === "" ? undefined : s),
    validate: (v: unknown) => (typeof v === "string" ? v : undefined),
  };
}

function boolDef(_name: string, defaultValue = false): TestDef {
  return {
    default: defaultValue,
    parse: parseBool,
    validate: (v: unknown) => (typeof v === "boolean" ? v : undefined),
  };
}

function enumDef(_name: string, values: string[], defaultValue: string | null = null): TestDef {
  const set = new Set(values);
  return {
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
 * Create a sync readFileSync from a mock FileSystemBoundary.
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

function createDeps(overrides?: Partial<ConfigDeps>): ConfigDeps {
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

interface CreateServiceOptions extends Partial<ConfigDeps> {
  fileEntries?: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>;
}

function createService(overrides?: CreateServiceOptions): Config {
  if (overrides?.fileEntries) {
    const entries = overrides.fileEntries;
    const fs = createFileSystemMock({ entries });
    const { fileEntries: _unused, ...rest } = overrides;
    void _unused;
    return new DefaultConfig(
      createDeps({
        fileSystem: fs,
        readFileSync: createSyncReader(entries),
        ...rest,
      })
    );
  }
  return new DefaultConfig(createDeps(overrides));
}

// =============================================================================
// Tests
// =============================================================================

describe("Config", () => {
  describe("register + load + get", () => {
    it("returns static defaults when no other sources exist", () => {
      const svc = createService();
      const key = svc.register("test.key", stringDef("test.key", "hello"));
      svc.load();

      expect(key.get()).toBe("hello");
    });

    it("applies computed defaults over static defaults", () => {
      const svc = createService({ isDevelopment: true });
      const key = svc.register("test.key", {
        ...stringDef("test.key", "prod-default"),
        computedDefault: (ctx) => (ctx.isDevelopment ? "dev-default" : undefined),
      });
      svc.load();

      expect(key.get()).toBe("dev-default");
    });

    it("reads values from config.json", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.key": "from-file" })),
        },
      });
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(key.get()).toBe("from-file");
    });

    it("env vars override file values", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.key": "from-file" })),
        },
        env: { CH_TEST__KEY: "from-env" },
      });
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(key.get()).toBe("from-env");
    });

    it("CLI flags override env vars", () => {
      const svc = createService({
        env: { CH_TEST__KEY: "from-env" },
        argv: ["--test.key=from-cli"],
      });
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(key.get()).toBe("from-cli");
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

      const computedDef: TestDef = {
        ...stringDef("test.d", "static-d"),
        computedDefault: () => "computed-d",
      };

      const a = svc.register("test.a", stringDef("test.a", "static-a"));
      const b = svc.register("test.b", stringDef("test.b", "static-b"));
      const c = svc.register("test.c", stringDef("test.c", "static-c"));
      const d = svc.register("test.d", computedDef);
      svc.load();

      expect(a.get()).toBe("file-a"); // file wins over static
      expect(b.get()).toBe("env-b"); // env wins over file
      expect(c.get()).toBe("cli-c"); // CLI wins over env
      expect(d.get()).toBe("file-d"); // file wins over computed
    });

    it("handles missing config.json gracefully", () => {
      const svc = createService(); // no file in mock fs
      const key = svc.register("test.key", stringDef("test.key", "fallback"));
      svc.load();

      expect(key.get()).toBe("fallback");
    });

    it("supports boolean CLI flags without value", () => {
      const svc = createService({ argv: ["--test.flag"] });
      const flag = svc.register("test.flag", boolDef("test.flag"));
      svc.load();

      expect(flag.get()).toBe(true);
    });

    it("supports --key value CLI format", () => {
      const svc = createService({ argv: ["--test.key", "value"] });
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(key.get()).toBe("value");
    });
  });

  describe("validation", () => {
    it("strips unknown keys from config.json and warns (does not throw)", () => {
      const writes: Array<{ path: string; content: string }> = [];
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.key": "kept", "unknown.key": "value" })),
        },
        logger,
        writeFileSync: (path, content) => {
          writes.push({ path, content });
        },
      });
      const key = svc.register("test.key", stringDef("test.key"));

      svc.load();

      expect(key.get()).toBe("kept");
      expect(logger.warn).toHaveBeenCalledWith("Unknown config key (ignored)", {
        source: "config.json",
        key: "unknown.key",
      });
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0]!.content)).toEqual({ "test.key": "kept" });
    });

    it("does not rewrite config.json when there is nothing to strip", () => {
      const writes: Array<{ path: string; content: string }> = [];
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.key": "value" })),
        },
        writeFileSync: (path, content) => {
          writes.push({ path, content });
        },
      });
      svc.register("test.key", stringDef("test.key"));
      svc.load();

      expect(writes).toHaveLength(0);
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

    it("warns and ignores unknown env vars instead of crashing", () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({
        env: { CH_TEST__KEY: "kept", CH_UNKNOWN__OLD: "leftover" },
        logger,
      });
      const key = svc.register("test.key", stringDef("test.key", "fallback"));

      expect(() => svc.load()).not.toThrow();
      expect(key.get()).toBe("kept");
      expect(logger.warn).toHaveBeenCalledWith("Unknown config key (ignored)", {
        source: "env var",
        key: "unknown.old",
      });
    });

    it("warns and ignores unknown CLI flags instead of crashing", () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({ argv: ["--test.key=cli", "--inspect=9229"], logger });
      const key = svc.register("test.key", stringDef("test.key"));

      expect(() => svc.load()).not.toThrow();
      expect(key.get()).toBe("cli");
      expect(logger.warn).toHaveBeenCalledWith("Unknown config key (ignored)", {
        source: "CLI flag",
        key: "inspect",
      });
    });

    it("ignores a deprecated key set via env var (no crash)", () => {
      const svc = createService({ env: { CH_TEST__OLD: "ignored" } });
      svc.register("test.old", { ...stringDef("test.old", "default"), deprecated: true });

      expect(() => svc.load()).not.toThrow();
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

      expect(() => svc.load()).toThrow("Config.load() has already been called");
    });
  });

  describe("set()", () => {
    it("updates effective value", async () => {
      const svc = createService();
      const key = svc.register("test.key", stringDef("test.key", "initial"));
      svc.load();

      await key.set("updated");
      expect(key.get()).toBe("updated");
    });

    it("persists to config.json by default", async () => {
      const fs = createFileSystemMock({
        entries: { "/app": directory() },
      });
      const svc = createService({ fileSystem: fs });
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      await key.set("persisted");

      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({ "test.key": "persisted" });
    });

    it("does not persist when persist=false", async () => {
      const fs = createFileSystemMock({
        entries: { "/app": directory() },
      });
      const svc = createService({ fileSystem: fs });
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      await key.set("memory-only", { persist: false });
      expect(key.get()).toBe("memory-only");

      // Config file should not exist
      await expect(fs.readFile(CONFIG_PATH)).rejects.toThrow();
    });

    it("preserves existing file content on set", async () => {
      const entries = {
        "/app": directory(),
        "/app/config.json": file(JSON.stringify({ "test.a": "existing" })),
      };
      const fs = createFileSystemMock({ entries });
      const svc = new DefaultConfig(
        createDeps({
          fileSystem: fs,
          readFileSync: createSyncReader(entries),
        })
      );
      svc.register("test.a", stringDef("test.a"));
      const b = svc.register("test.b", stringDef("test.b"));
      svc.load();

      await b.set("new-value");

      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({ "test.a": "existing", "test.b": "new-value" });
    });

    it("persists null to file when set to null", async () => {
      const entries = {
        "/app": directory(),
        "/app/config.json": file(JSON.stringify({ "test.key": "value" })),
      };
      const fs = createFileSystemMock({ entries });
      const svc = new DefaultConfig(
        createDeps({
          fileSystem: fs,
          readFileSync: createSyncReader(entries),
        })
      );
      const key = svc.register("test.key", enumDef("test.key", ["value"], null));
      svc.load();

      await key.set(null);

      expect(key.get()).toBeNull();
      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({ "test.key": null });
    });

    it("reset() reverts to default and removes key from file", async () => {
      const entries = {
        "/app": directory(),
        "/app/config.json": file(JSON.stringify({ "test.key": "value" })),
      };
      const fs = createFileSystemMock({ entries });
      const svc = new DefaultConfig(
        createDeps({
          fileSystem: fs,
          readFileSync: createSyncReader(entries),
        })
      );
      const key = svc.register("test.key", enumDef("test.key", ["value"], null));
      svc.load();

      await key.reset();

      expect(key.get()).toBeNull();
      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({});
    });

    it("throws on invalid value", async () => {
      const svc = createService();
      const flag = svc.register("test.flag", boolDef("test.flag"));
      svc.load();

      await expect(flag.set("not-bool")).rejects.toThrow(ConfigValidationError);
    });
  });

  describe("invalid JSON in config.json", () => {
    it("load() renames the file to config.json.broken and uses defaults", () => {
      const renames: Array<{ from: string; to: string }> = [];
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file("{ not valid json"),
        },
        logger,
        renameSync: (from, to) => {
          renames.push({ from, to });
        },
      });
      const key = svc.register("test.key", stringDef("test.key", "fallback"));
      svc.load();

      expect(key.get()).toBe("fallback");
      const backupPath = new Path(CONFIG_PATH.dirname, "config.json.broken");
      expect(renames).toEqual([{ from: CONFIG_PATH.toNative(), to: backupPath.toNative() }]);
      expect(logger.warn).toHaveBeenCalledWith(
        "Invalid JSON in config.json, backed up to config.json.broken; using defaults",
        expect.objectContaining({
          path: CONFIG_PATH.toString(),
          backup: backupPath.toString(),
        })
      );
    });

    it("load() throws if the backup rename fails", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file("not json"),
        },
        renameSync: () => {
          throw new Error("EACCES: rename forbidden");
        },
      });
      svc.register("test.key", stringDef("test.key"));

      expect(() => svc.load()).toThrow("EACCES: rename forbidden");
    });

    it("set() renames the broken file and writes a fresh single-key file", async () => {
      const entries = {
        "/app": directory(),
        "/app/config.json": file("{{ broken"),
      };
      const fs = createFileSystemMock({ entries });
      const svc = new DefaultConfig(
        createDeps({
          fileSystem: fs,
          readFileSync: () => {
            const err = new Error("ENOENT") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          },
        })
      );
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      await key.set("fresh");

      const content = await fs.readFile(CONFIG_PATH);
      expect(JSON.parse(content)).toEqual({ "test.key": "fresh" });
      const backup = await fs.readFile(new Path("/app/config.json.broken"));
      expect(backup).toBe("{{ broken");
    });

    it("set() throws when the backup rename fails and does not overwrite", async () => {
      const entries = {
        "/app": directory(),
        "/app/config.json": file("{{ still broken"),
      };
      const fs = createFileSystemMock({ entries });
      fs.rename = vi.fn(async () => {
        throw new Error("EACCES: cannot rename");
      });
      const svc = new DefaultConfig(
        createDeps({
          fileSystem: fs,
          readFileSync: () => {
            const err = new Error("ENOENT") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          },
        })
      );
      const key = svc.register("test.key", stringDef("test.key"));
      svc.load();

      await expect(key.set("fresh")).rejects.toThrow("EACCES: cannot rename");

      const content = await fs.readFile(CONFIG_PATH);
      expect(content).toBe("{{ still broken");
    });
  });

  describe("deprecated keys", () => {
    it("preserves entry in config.json and does not rewrite", () => {
      const writes: Array<{ path: string; content: string }> = [];
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.old": "value-from-old" })),
        },
        writeFileSync: (path, content) => {
          writes.push({ path, content });
        },
      });
      svc.register("test.old", { ...stringDef("test.old"), deprecated: true });
      svc.load();

      expect(writes).toHaveLength(0);
    });

    it("accessor get() and set() throw with reason 'deprecated'", () => {
      const svc = createService();
      const old = svc.register("test.old", { ...stringDef("test.old"), deprecated: true });
      svc.load();

      expect(() => old.get()).toThrow(ConfigValidationError);
      try {
        old.get();
      } catch (e) {
        expect((e as ConfigValidationError).detail.reason).toBe("deprecated");
      }
      const setDeprecated = old.set as () => never;
      expect(() => setDeprecated()).toThrow(ConfigValidationError);
    });

    it("is hidden from help text and overrides", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "test.old": "value-from-old" })),
        },
      });
      svc.register("test.active", stringDef("test.active", "active-default"));
      svc.register("test.old", { ...stringDef("test.old"), deprecated: true });
      svc.load();

      expect(svc.getHelpText()).not.toContain("test.old");
      expect(svc.getHelpText()).toContain("test.active");
      expect(svc.getOverrides()).toEqual({});
    });
  });

  describe("legacy names", () => {
    function defWithLegacy(name: string): TestDef {
      return {
        ...stringDef(name),
        legacyNames: {
          "legacy.old-name": (v: unknown) => (typeof v === "string" ? `migrated:${v}` : undefined),
        },
      };
    }

    it("translates a legacy entry and applies it as the new key", () => {
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "legacy.old-name": "raw" })),
        },
      });
      const newKey = svc.register("test.new", defWithLegacy("test.new"));
      svc.load();

      expect(newKey.get()).toBe("migrated:raw");
    });

    it("preserves the legacy entry in config.json (no rewrite)", () => {
      const writes: Array<{ path: string; content: string }> = [];
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "legacy.old-name": "raw" })),
        },
        writeFileSync: (path, content) => {
          writes.push({ path, content });
        },
      });
      svc.register("test.new", defWithLegacy("test.new"));
      svc.load();

      expect(writes).toHaveLength(0);
    });

    it("new key wins on conflict in config.json; legacy ignored with warn", () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(
            JSON.stringify({ "legacy.old-name": "raw", "test.new": "explicit" })
          ),
        },
        logger,
      });
      const newKey = svc.register("test.new", defWithLegacy("test.new"));
      svc.load();

      expect(newKey.get()).toBe("explicit");
      expect(logger.warn).toHaveBeenCalledWith("Legacy config key shadowed by new key (ignored)", {
        source: "config.json",
        legacy: "legacy.old-name",
        newKey: "test.new",
      });
    });

    it("falls back to default when translator returns undefined", () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({
        fileEntries: {
          "/app": directory(),
          "/app/config.json": file(JSON.stringify({ "legacy.old-name": 42 })),
        },
        logger,
      });
      const newKey = svc.register("test.new", defWithLegacy("test.new"));
      svc.load();

      expect(newKey.get()).toBe("default");
      expect(logger.warn).toHaveBeenCalledWith(
        "Legacy config key could not be translated (using default)",
        { source: "config.json", legacy: "legacy.old-name", newKey: "test.new", value: "42" }
      );
    });

    it("honors a legacy name via env var with pure-rename (new key's parse, not the translator)", () => {
      const svc = createService({
        env: { CH_LEGACY__OLD_NAME: "raw" },
      });
      const newKey = svc.register("test.new", defWithLegacy("test.new"));

      // Pure-rename runs the raw string through the new key's parse(), so the value
      // is "raw" — NOT "migrated:raw" (the translator only applies to typed config.json).
      expect(() => svc.load()).not.toThrow();
      expect(newKey.get()).toBe("raw");
    });

    it("honors a legacy name via CLI flag with pure-rename", () => {
      const svc = createService({
        argv: ["--legacy.old-name=raw"],
      });
      const newKey = svc.register("test.new", defWithLegacy("test.new"));

      expect(() => svc.load()).not.toThrow();
      expect(newKey.get()).toBe("raw");
    });

    it("new key wins over legacy via env var (legacy shadowed)", () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({
        env: { CH_LEGACY__OLD_NAME: "raw", CH_TEST__NEW: "explicit" },
        logger,
      });
      const newKey = svc.register("test.new", defWithLegacy("test.new"));
      svc.load();

      expect(newKey.get()).toBe("explicit");
      expect(logger.warn).toHaveBeenCalledWith("Legacy config key shadowed by new key (ignored)", {
        source: "env var",
        legacy: "legacy.old-name",
        newKey: "test.new",
      });
    });

    it("warns at register() on legacy-name collision (last writer wins)", () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn() };
      const svc = createService({ logger });
      svc.register("test.first", defWithLegacy("test.first"));
      svc.register("test.second", defWithLegacy("test.second"));

      expect(logger.warn).toHaveBeenCalledWith("Legacy config name collision (last writer wins)", {
        legacy: "legacy.old-name",
        previousOwner: "test.first",
        newOwner: "test.second",
      });
    });
  });

  describe("getHelpText", () => {
    it("returns help text with registered keys", () => {
      const svc = createService();
      svc.register("test.key", { ...stringDef("test.key", "hello"), description: "A test key" });
      svc.load();

      const text = svc.getHelpText();
      expect(text).toContain("test.key");
      expect(text).toContain("hello");
      expect(text).toContain("A test key");
    });

    it("returns help text with defaults even after failed load", () => {
      const svc = createService({ env: { CH_TEST__FLAG: "invalid" } });
      svc.register("test.flag", {
        ...boolDef("test.flag", false),
        description: "A flag",
        validValues: "true|false",
      });

      expect(() => svc.load()).toThrow(ConfigValidationError);

      const text = svc.getHelpText();
      expect(text).toContain("test.flag");
      expect(text).toContain("false");
      expect(text).toContain("A flag");
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
// Standalone tokenizer tests
// =============================================================================

describe("parseEnvVars", () => {
  it("extracts CH_* env vars as raw string values keyed by config key", () => {
    const result = parseEnvVars({ CH_TEST__KEY: "hello", CH_TEST__FLAG: "true" });
    expect(result).toEqual({ "test.key": "hello", "test.flag": "true" });
  });

  it("skips _CH_ prefixed vars", () => {
    const result = parseEnvVars({ _CH_TEST__KEY: "skip" });
    expect(result).toEqual({});
  });

  it("handles kebab-case conversion (underscore → hyphen)", () => {
    const result = parseEnvVars({ CH_TEST__DEV_OPTION: "value" });
    expect(result).toEqual({ "test.dev-option": "value" });
  });

  it("collects unknown CH_* keys as raw values (classification happens later)", () => {
    const result = parseEnvVars({ CH_UNKNOWN__KEY: "leftover" });
    expect(result).toEqual({ "unknown.key": "leftover" });
  });
});

describe("parseCliArgs", () => {
  it("tokenizes --key=value format", () => {
    expect(parseCliArgs(["--test.key=hello"])).toEqual({ "test.key": "hello" });
  });

  it("tokenizes --key value format", () => {
    expect(parseCliArgs(["--test.key", "hello"])).toEqual({ "test.key": "hello" });
  });

  it("treats bare --flag as 'true'", () => {
    expect(parseCliArgs(["--test.flag"])).toEqual({ "test.flag": "true" });
  });

  it("tokenizes unknown flags too (classification happens later)", () => {
    expect(parseCliArgs(["--unknown-flag=val"])).toEqual({ "unknown-flag": "val" });
  });
});
