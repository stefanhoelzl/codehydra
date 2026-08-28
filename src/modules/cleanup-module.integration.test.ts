// @vitest-environment node
/**
 * Integration tests for CleanupModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * - app:start / start → every rule runs against a behavioral filesystem
 *
 * The sweep is fire-and-forget, so the dispatch resolves before it finishes.
 * Tests wait on the observable outcome (`vi.waitFor`) rather than on the
 * handler, which is exactly the guarantee the module offers: startup does not
 * block on cleanup.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent } from "../intents/app-start";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import { testPath } from "../shared/test-fixtures";
import {
  createFileSystemMock,
  directory,
  file,
  type MockFileSystemBoundary,
} from "../boundaries/platform/filesystem.state-mock";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import type { Logger } from "../boundaries/platform/logging";
import { createCleanupModule, type CleanupRule } from "./cleanup-module";

// =============================================================================
// Test Setup
// =============================================================================

interface SetupOptions {
  readonly entries?: Record<string, ReturnType<typeof directory> | ReturnType<typeof file>>;
  readonly rules: readonly CleanupRule[];
  readonly isPackagedBuild?: boolean;
  readonly logger?: Logger;
}

interface TestSetup {
  readonly run: () => Promise<void>;
  readonly fileSystem: MockFileSystemBoundary;
}

function createTestSetup(options: SetupOptions): TestSetup {
  const dispatcher = createMockDispatcher();
  // The data root always exists in a real install (config.json lives in it), and
  // `retire` asks the parent whether its target is there — so seed it.
  const fileSystem = createFileSystemMock({
    entries: { "/test/app-data": directory(), ...options.entries },
  });

  dispatcher.registerOperation(
    createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start", {
      throwOnError: false,
    })
  );

  dispatcher.registerModule(
    createCleanupModule({
      fileSystem,
      pathProvider: createMockPathProvider(),
      logger: options.logger ?? SILENT_LOGGER,
      isPackagedBuild: options.isPackagedBuild ?? true,
      rules: options.rules,
    })
  );

  return {
    fileSystem,
    run: async () => {
      await dispatcher.dispatch<AppStartIntent>({ type: INTENT_APP_START, payload: {} });
    },
  };
}

/** Path helper: everything a rule touches hangs off the mock data root. */
function data(subpath: string): string {
  return `/test/app-data/${subpath}`;
}

function exists(fileSystem: MockFileSystemBoundary, path: string): boolean {
  // Through `testPath`, not the raw literal. It normalizes the way the mock's
  // own accessors do — lowercasing on Windows, so a name holding an uppercase
  // letter (every `...T07-35-51...` log) is still found — and roots the path
  // under the fixture directory, which `$.entries` does not do for us because
  // it is the raw map rather than a normalizing accessor.
  return fileSystem.$.entries.has(testPath(path).toString());
}

// =============================================================================
// Tests
// =============================================================================

describe("CleanupModule Integration", () => {
  describe("retire", () => {
    it("removes a retired directory and everything under it", async () => {
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("code-server")]: directory(),
          [data("code-server/4.127.0")]: directory(),
          [data("code-server/4.127.0/node")]: file("binary"),
        },
        rules: [{ kind: "retire", path: "code-server" }],
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("code-server"))).toBe(false);
        expect(exists(fileSystem, data("code-server/4.127.0/node"))).toBe(false);
      });
    });

    it("removes a retired file", async () => {
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("opencode")]: directory(),
          [data("opencode/opencode.codehydra.json")]: file("{}"),
          [data("opencode/1.0.223")]: directory(),
        },
        rules: [{ kind: "retire", path: "opencode/opencode.codehydra.json" }],
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("opencode/opencode.codehydra.json"))).toBe(false);
      });
      // Retiring one entry must not take its neighbours with it.
      expect(exists(fileSystem, data("opencode/1.0.223"))).toBe(true);
    });

    it("reports nothing when the retired path was never there", async () => {
      const logger = { ...SILENT_LOGGER, info: vi.fn(), warn: vi.fn() };
      const { run } = createTestSetup({
        entries: { [data("logs")]: directory() },
        rules: [{ kind: "retire", path: "code-server" }],
        logger,
      });

      await run();
      await vi.waitFor(() => expect(logger.warn).not.toHaveBeenCalled());

      // An absent path is the normal case on most machines: no summary line,
      // and certainly no warning.
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe("keepRecent", () => {
    it("keeps the newest entries by name and deletes the rest", async () => {
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("logs")]: directory(),
          [data("logs/2026-01-12T21-33-04-aaaa.log")]: file("old"),
          [data("logs/2026-06-10T10-00-00-bbbb.log")]: file("older"),
          [data("logs/2026-08-28T07-35-51-cccc.log")]: file("current"),
        },
        rules: [{ kind: "keepRecent", path: "logs", keep: 2 }],
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("logs/2026-01-12T21-33-04-aaaa.log"))).toBe(false);
      });
      expect(exists(fileSystem, data("logs/2026-08-28T07-35-51-cccc.log"))).toBe(true);
      expect(exists(fileSystem, data("logs/2026-06-10T10-00-00-bbbb.log"))).toBe(true);
    });

    it("ranks entries that are not session logs as oldest", async () => {
      // `electron.log` is Chromium's own log, not ours. Sorted naively it would
      // beat every timestamped name ("e" > "2") and survive forever; it must be
      // the first thing to go instead.
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("logs")]: directory(),
          [data("logs/electron.log")]: file("chromium"),
          [data("logs/2026-08-27T14-09-13-aaaa.log")]: file("older"),
          [data("logs/2026-08-28T07-35-51-bbbb.log")]: file("current"),
        },
        rules: [{ kind: "keepRecent", path: "logs", keep: 2 }],
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("logs/electron.log"))).toBe(false);
      });
      expect(exists(fileSystem, data("logs/2026-08-28T07-35-51-bbbb.log"))).toBe(true);
      expect(exists(fileSystem, data("logs/2026-08-27T14-09-13-aaaa.log"))).toBe(true);
    });

    it("still recognises session logs when their names arrived lowercased", async () => {
      // What Windows looks like: `Path` lowercases there (it models a
      // case-insensitive filesystem), so names reach the rule as
      // `2026-08-28t07-...`. When the pattern anchored on an uppercase `T`,
      // nothing matched, every entry ranked equal, and `electron.log` won the
      // name sort on "e" > "2" — surviving while the real logs were swept.
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("logs")]: directory(),
          [data("logs/electron.log")]: file("chromium"),
          [data("logs/2026-08-27t14-09-13-aaaa.log")]: file("older"),
          [data("logs/2026-08-28t07-35-51-bbbb.log")]: file("current"),
        },
        rules: [{ kind: "keepRecent", path: "logs", keep: 2 }],
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("logs/electron.log"))).toBe(false);
      });
      expect(exists(fileSystem, data("logs/2026-08-28t07-35-51-bbbb.log"))).toBe(true);
      expect(exists(fileSystem, data("logs/2026-08-27t14-09-13-aaaa.log"))).toBe(true);
    });

    it("keeps everything when the directory holds fewer than the limit", async () => {
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("logs")]: directory(),
          [data("logs/2026-08-28T07-35-51-aaaa.log")]: file("current"),
        },
        rules: [{ kind: "keepRecent", path: "logs", keep: 20 }],
      });

      await run();
      await vi.waitFor(() => expect(exists(fileSystem, data("logs"))).toBe(true));

      expect(exists(fileSystem, data("logs/2026-08-28T07-35-51-aaaa.log"))).toBe(true);
    });
  });

  describe("pruneEmpty", () => {
    it("removes childless directories and leaves the rest alone", async () => {
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("screenshots")]: directory(),
          [data("screenshots/gone-abc123")]: directory(),
          [data("screenshots/live-def456")]: directory(),
          [data("screenshots/live-def456/feature.png")]: file("png"),
        },
        rules: [{ kind: "pruneEmpty", path: "screenshots" }],
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("screenshots/gone-abc123"))).toBe(false);
      });
      expect(exists(fileSystem, data("screenshots/live-def456/feature.png"))).toBe(true);
    });
  });

  describe("bundle", () => {
    it("keeps only the live version", async () => {
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("vscodium")]: directory(),
          [data("vscodium/1.120.00001")]: directory(),
          [data("vscodium/1.126.04524")]: directory(),
          [data("vscodium/1.126.04524/node")]: file("binary"),
        },
        rules: [
          { kind: "bundle", path: "vscodium", live: () => "1.126.04524", packagedOnly: true },
        ],
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("vscodium/1.120.00001"))).toBe(false);
      });
      expect(exists(fileSystem, data("vscodium/1.126.04524/node"))).toBe(true);
    });

    it("removes every version when nothing is downloaded for this agent", async () => {
      // Claude ships its binary rather than downloading one (CLAUDE_VERSION is
      // null), so any version directory is a leftover from a config override.
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("claude")]: directory(),
          [data("claude/1.2.3")]: directory(),
        },
        rules: [{ kind: "bundle", path: "claude", live: () => null, packagedOnly: true }],
      });

      await run();

      await vi.waitFor(() => expect(exists(fileSystem, data("claude/1.2.3"))).toBe(false));
    });

    it("does nothing in a development build", async () => {
      // Dev shares its data root with binaries pnpm install and the test
      // helpers download, pinned to versions the running app does not resolve.
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("opencode")]: directory(),
          [data("opencode/0.9.0")]: directory(),
        },
        rules: [{ kind: "bundle", path: "opencode", live: () => "1.0.223", packagedOnly: true }],
        isPackagedBuild: false,
      });

      await run();
      await vi.waitFor(() => expect(exists(fileSystem, data("opencode"))).toBe(true));

      expect(exists(fileSystem, data("opencode/0.9.0"))).toBe(true);
    });

    it("reads the live version when it runs, not when it is declared", async () => {
      let resolved = "0.9.0";
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("opencode")]: directory(),
          [data("opencode/0.9.0")]: directory(),
          [data("opencode/1.0.223")]: directory(),
        },
        rules: [{ kind: "bundle", path: "opencode", live: () => resolved, packagedOnly: true }],
      });

      // Config settles after the module is constructed.
      resolved = "1.0.223";
      await run();

      await vi.waitFor(() => expect(exists(fileSystem, data("opencode/0.9.0"))).toBe(false));
      expect(exists(fileSystem, data("opencode/1.0.223"))).toBe(true);
    });
  });

  describe("rule isolation", () => {
    it("runs the remaining rules after one fails, and warns about the failure", async () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn(), info: vi.fn() };
      const { run, fileSystem } = createTestSetup({
        entries: {
          // Unreadable, not absent: the rule must report it rather than treat
          // the directory as empty and claim there was nothing to clean.
          [data("screenshots")]: directory({ error: "EACCES" }),
          [data("logs")]: directory(),
          [data("logs/2026-01-12T21-33-04-aaaa.log")]: file("old"),
          [data("logs/2026-08-28T07-35-51-bbbb.log")]: file("current"),
        },
        rules: [
          { kind: "pruneEmpty", path: "screenshots" },
          { kind: "keepRecent", path: "logs", keep: 1 },
        ],
        logger,
      });

      await run();

      await vi.waitFor(() => {
        expect(exists(fileSystem, data("logs/2026-01-12T21-33-04-aaaa.log"))).toBe(false);
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "Cleanup rule failed",
        expect.objectContaining({ rule: "pruneEmpty", path: "screenshots" })
      );
    });

    it("runs rules in declaration order", async () => {
      // `claude/configs` is retired before the bundle rule sweeps its parent,
      // so the retired directory is never mistaken for a version to keep.
      const seen: string[] = [];
      const { run, fileSystem } = createTestSetup({
        entries: {
          [data("claude")]: directory(),
          [data("claude/configs")]: directory(),
          [data("claude/configs/feature-a-1a2b")]: directory(),
        },
        rules: [
          { kind: "retire", path: "claude/configs" },
          {
            kind: "bundle",
            path: "claude",
            live: () => {
              seen.push("bundle");
              return null;
            },
            packagedOnly: true,
          },
        ],
      });

      await run();

      await vi.waitFor(() => expect(seen).toEqual(["bundle"]));
      expect(exists(fileSystem, data("claude/configs"))).toBe(false);
    });

    it("summarises what it removed once, at info", async () => {
      const logger = { ...SILENT_LOGGER, warn: vi.fn(), info: vi.fn() };
      const { run } = createTestSetup({
        entries: {
          [data("code-server")]: directory(),
          [data("screenshots")]: directory(),
          [data("screenshots/gone-abc123")]: directory(),
        },
        rules: [
          { kind: "retire", path: "code-server" },
          { kind: "pruneEmpty", path: "screenshots" },
        ],
        logger,
      });

      await run();

      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(1));
      expect(logger.info).toHaveBeenCalledWith(
        "Cleanup removed stale entries",
        expect.objectContaining({ entries: 2 })
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
