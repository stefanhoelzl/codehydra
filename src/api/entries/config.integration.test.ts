// @vitest-environment node
/**
 * Integration tests for the config entries, against a real DefaultConfig.
 *
 * The entries are thin, so what is under test is mostly the contract they add
 * on top of Config: which keys are visible, string values going through each
 * key's parse(), redaction on read, and the row shape set/reset report.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createFileSystemMock, directory } from "../../boundaries/platform/filesystem.state-mock";
import { DefaultConfig, type Config } from "../../boundaries/platform/config";
import { storeBoolean, storeNumber, storeString } from "../../boundaries/platform/store-definition";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import { testPath } from "../../shared/test-fixtures";
import { ApiError } from "../errors";
import type { OperationName } from "../names";
import type { OperationRegistry } from "../registry";
import { createRegistry } from "./index";
import { createLockModule } from "../../modules/lock-module";

const CONFIG_PATH = testPath("/app/config.json");

interface Setup {
  readonly config: Config;
  readonly fs: FileSystemBoundary;
  readonly registry: OperationRegistry;
}

function setup(options: { env?: Record<string, string> } = {}): Setup {
  const fs = createFileSystemMock({ entries: { "/app": directory() } });
  const config = new DefaultConfig({
    configPath: CONFIG_PATH,
    fileSystem: fs,
    logger: SILENT_LOGGER,
    isDevelopment: false,
    isPackaged: true,
    env: options.env ?? {},
    argv: [],
    readFileSync: () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  });

  config.register("sidebar.width", {
    default: 250,
    description: "Sidebar width",
    applies: "live",
    ...storeNumber({ min: 250, max: 1000 }),
  });
  config.register("silent", { default: false, ...storeBoolean() });
  config.register("log.level", {
    default: "warn",
    computedDefault: () => "info",
    ...storeString(),
  });
  config.register("version.claude", { default: null, ...storeString({ nullable: true }) });
  config.register("secret.token", {
    default: null,
    redact: true,
    applies: "live",
    ...storeString({ nullable: true }),
  });
  config.register("auto-workspace.sources", {
    default: null,
    omit: true,
    ...storeString({ nullable: true }),
  });
  config.register("help", { default: false, ...storeBoolean() });
  config.register("old.key", {
    default: null,
    deprecated: true,
    ...storeString({ nullable: true }),
  });
  config.load();

  const registry = createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config,
      readUserGuide: async () => "",
    },
    SILENT_LOGGER
  );
  return { config, fs, registry };
}

function call(registry: OperationRegistry, name: OperationName, input: unknown): Promise<unknown> {
  return registry.invoke(
    registry.get(name),
    {
      workspacePath: null,
      callerWorkspacePath: null,
      cwd: null,
      signal: new AbortController().signal,
    },
    input
  );
}

async function persisted(fs: FileSystemBoundary): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(CONFIG_PATH)) as Record<string, unknown>;
}

describe("config entries", () => {
  describe("config.list", () => {
    it("lists user settings only, sorted, as rows", async () => {
      const { registry } = setup();

      const rows = (await call(registry, "config.list", {})) as { key: string }[];

      // help is a CLI action and old.key is deprecated: neither is a setting.
      expect(rows.map((r) => r.key)).toEqual([
        "auto-workspace.sources",
        "log.level",
        "secret.token",
        "sidebar.width",
        "silent",
        "version.claude",
      ]);
      expect(rows.find((r) => r.key === "sidebar.width")).toEqual({
        key: "sidebar.width",
        value: 250,
        default: 250,
        source: "default",
        applies: "live",
        description: "Sidebar width",
        validValues: expect.any(String),
      });
    });

    it("reports help fields a key does not define as null, with description last", async () => {
      const { registry } = setup();

      const rows = (await call(registry, "config.list", {})) as Record<string, unknown>[];
      const row = rows.find((r) => r.key === "log.level")!;

      expect(row).toMatchObject({ description: null });
      expect(Object.keys(row).at(-1)).toBe("description");
    });

    it("reports the computed default, and restart for keys that do not declare live", async () => {
      const { registry } = setup();

      const rows = (await call(registry, "config.list", {})) as Record<string, unknown>[];

      expect(rows.find((r) => r.key === "log.level")).toMatchObject({
        default: "info",
        applies: "restart",
      });
    });

    it("hides redacted values and omits omitted ones", async () => {
      const { registry, config } = setup();
      await config.set("secret.token", "hunter2");
      await config.set("auto-workspace.sources", "---\nname: a\n");

      const rows = (await call(registry, "config.list", {})) as Record<string, unknown>[];

      expect(rows.find((r) => r.key === "secret.token")?.value).toBe("<redacted>");
      expect(rows.find((r) => r.key === "auto-workspace.sources")?.value).toBe("<omitted>");
    });

    it("reports an env override as its source", async () => {
      const { registry } = setup({ env: { CH_SIDEBAR__WIDTH: "400" } });

      const rows = (await call(registry, "config.list", {})) as Record<string, unknown>[];

      expect(rows.find((r) => r.key === "sidebar.width")).toMatchObject({
        value: 400,
        source: "env",
      });
    });
  });

  describe("config.get", () => {
    it("returns the bare effective value", async () => {
      const { registry } = setup();

      expect(await call(registry, "config.get", { key: "sidebar.width" })).toBe(250);
    });

    it("returns an omitted value in the clear but a redacted one as the token", async () => {
      const { registry, config } = setup();
      await config.set("secret.token", "hunter2");
      await config.set("auto-workspace.sources", "---\nname: a\n");

      expect(await call(registry, "config.get", { key: "secret.token" })).toBe("<redacted>");
      expect(await call(registry, "config.get", { key: "auto-workspace.sources" })).toBe(
        "---\nname: a\n"
      );
    });

    it.each(["no.such.key", "help", "old.key"])(
      "fails for %s, which is not a setting",
      async (key) => {
        const { registry } = setup();

        const error = await call(registry, "config.get", { key }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).category).toBe("not-found");
        expect((error as ApiError).message).toContain(`Unknown config key "${key}"`);
      }
    );
  });

  describe("config.set", () => {
    it("parses the string, persists it, and returns the row", async () => {
      const { registry, fs } = setup();

      const row = await call(registry, "config.set", { key: "sidebar.width", value: "300" });

      expect(row).toEqual({
        key: "sidebar.width",
        value: 300,
        default: 250,
        source: "user",
        applies: "live",
        description: "Sidebar width",
        validValues: expect.any(String),
      });
      expect(await persisted(fs)).toEqual({ "sidebar.width": 300 });
    });

    it("parses booleans and clears a nullable key with an empty string", async () => {
      const { registry, config } = setup();
      await config.set("version.claude", "1.2.3");

      await call(registry, "config.set", { key: "silent", value: "true" });
      await call(registry, "config.set", { key: "version.claude", value: "" });

      expect(config.getEffective()["silent"]).toBe(true);
      expect(config.getEffective()["version.claude"]).toBeNull();
    });

    it("rejects a value the key cannot parse, naming the valid values", async () => {
      const { registry, config } = setup();

      const error = await call(registry, "config.set", { key: "silent", value: "maybe" }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).category).toBe("usage");
      expect((error as ApiError).message).toContain('Invalid value "maybe"');
      expect((error as ApiError).message).toContain("Valid values:");
      expect(config.getEffective()["silent"]).toBe(false);
    });

    it("rejects a value that parses but fails validation", async () => {
      const { registry } = setup();

      const error = await call(registry, "config.set", { key: "sidebar.width", value: "10" }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).category).toBe("usage");
    });

    it("sets a redacted key but reports its value as the token", async () => {
      const { registry, config } = setup();

      const row = await call(registry, "config.set", { key: "secret.token", value: "hunter2" });

      expect(row).toMatchObject({ value: "<redacted>" });
      expect(config.getEffective()["secret.token"]).toBe("hunter2");
    });

    it("keeps an env override as the source after a set", async () => {
      const { registry } = setup({ env: { CH_SIDEBAR__WIDTH: "400" } });

      const row = await call(registry, "config.set", { key: "sidebar.width", value: "300" });

      expect(row).toMatchObject({ value: 300, source: "env" });
    });

    it("refuses keys that are not settings", async () => {
      const { registry } = setup();

      const error = await call(registry, "config.set", { key: "help", value: "true" }).catch(
        (e: unknown) => e
      );

      expect((error as ApiError).category).toBe("not-found");
      expect((error as ApiError).message).toContain('Unknown config key "help"');
    });
  });

  describe("config.reset", () => {
    it("removes the key from config.json and returns the default row", async () => {
      const { registry, fs } = setup();
      await call(registry, "config.set", { key: "sidebar.width", value: "300" });
      await call(registry, "config.set", { key: "silent", value: "true" });

      const row = await call(registry, "config.reset", { key: "sidebar.width" });

      expect(row).toEqual({
        key: "sidebar.width",
        value: 250,
        default: 250,
        source: "default",
        applies: "live",
        description: "Sidebar width",
        validValues: expect.any(String),
      });
      expect(await persisted(fs)).toEqual({ silent: true });
    });

    it("fails for an unknown key", async () => {
      const { registry } = setup();

      const error = await call(registry, "config.reset", { key: "nope" }).catch((e: unknown) => e);

      expect((error as ApiError).category).toBe("not-found");
    });
  });
});
