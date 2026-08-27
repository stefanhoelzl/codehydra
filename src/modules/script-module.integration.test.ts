// @vitest-environment node
/**
 * Integration tests for ScriptModule through the Dispatcher.
 *
 * Tests verify the full pipeline: dispatcher -> operation -> hook handlers.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";

import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import { INTENT_APP_START, APP_START_OPERATION_ID } from "../intents/app-start";
import type { AppStartIntent, InitHookContext } from "../intents/app-start";
import { createScriptModule } from "./script-module";
import type { RequiredScript } from "../intents/app-start";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import { FileSystemError } from "../shared/errors/service-errors";
import { Path } from "../utils/path/path";

// =============================================================================
// Test Doubles
// =============================================================================

/** Runs "init" hook point with InitHookContext. */
function createMinimalInitOperation(scripts: readonly RequiredScript[] = ["ch-claude", "code"]) {
  return createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "init", {
    hookContext: (ctx): InitHookContext => ({
      intent: ctx.intent,
      requiredScripts: scripts,
      capabilities: { "app-ready": true },
    }),
  });
}

interface FakeFsOptions {
  /** Content per native path. A path absent here reads as ENOENT. */
  readonly files?: Record<string, string>;
  /** Entry names present in the bin directory. Defaults to the keys under /app-data/bin. */
  readonly binEntries?: readonly string[];
}

/**
 * Behavioural filesystem double: reads/writes a path->content map so the module's
 * "write only what differs" decision is exercised for real rather than asserted
 * against a call count.
 */
function createFakeFileSystem(options?: FakeFsOptions) {
  const files = new Map(Object.entries(options?.files ?? {}));
  const binEntries =
    options?.binEntries ??
    [...files.keys()]
      .filter((p) => p.startsWith("/app-data/bin/"))
      .map((p) => p.slice("/app-data/bin/".length));

  return {
    files,
    readFile: vi.fn(async (path: Path) => {
      const content = files.get(path.toString());
      if (content === undefined) {
        throw new FileSystemError("ENOENT", path.toString(), "ENOENT: no such file or directory");
      }
      return content;
    }),
    readdir: vi.fn(async () =>
      binEntries.map((name) => ({
        name,
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      }))
    ),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn(async (path: Path) => {
      files.delete(path.toString());
    }),
    copyTree: vi.fn(async (src: Path, dest: Path) => {
      files.set(dest.toString(), files.get(src.toString()) ?? "");
    }),
    // Scripts are written by content rather than copied, so a template can be
    // rendered on the way.
    writeFile: vi.fn(async (path: Path, content: string) => {
      files.set(path.toString(), content);
    }),
    makeExecutable: vi.fn().mockResolvedValue(undefined),
  };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() };

function createHarness(
  scripts: readonly RequiredScript[],
  fileSystem: ReturnType<typeof createFakeFileSystem>
) {
  // Distinct runtime vs asset roots: the wrappers MUST be read from runtimePath
  // (extraResources / resources/bin, real files), NOT assetPath (inside
  // app.asar, unreadable via original-fs in the packaged app). If this regresses
  // to assetPath, the /runtime assertions below fail.
  const pathProvider = createMockPathProvider({
    dataRootDir: "/app-data",
    runtimeRootDir: "/runtime",
    assetsRootDir: "/assets",
  });

  const dispatcher = createMockDispatcher();
  dispatcher.registerOperation(createMinimalInitOperation(scripts));
  dispatcher.registerModule(
    createScriptModule({
      fileSystem: fileSystem as never,
      pathProvider: pathProvider as never,
      logger: logger as never,
      templateVariables: () => ({ ideNode: "/ide/node" }),
    })
  );

  return {
    dispatch: () => dispatcher.dispatch<AppStartIntent>({ type: INTENT_APP_START, payload: {} }),
  };
}

/** The bundled sources every test starts from. */
const BUNDLED = {
  "/runtime/bin/ch-claude": "claude-sh",
  "/runtime/bin/ch-claude.cjs": "claude-js",
  "/runtime/bin/ch-claude.cmd": "claude-cmd",
  "/runtime/bin/code": "code-sh",
};
const SCRIPTS = ["ch-claude", "ch-claude.cjs", "ch-claude.cmd", "code"];

// =============================================================================
// Tests
// =============================================================================

describe("ScriptModule Integration", () => {
  it("writes declared scripts from runtimePath when the bin directory is empty", async () => {
    const fileSystem = createFakeFileSystem({ files: { ...BUNDLED } });
    await createHarness(SCRIPTS, fileSystem).dispatch();

    expect(fileSystem.mkdir).toHaveBeenCalledWith(new Path("/app-data/bin"));

    // Written by content rather than copied, so a templated script can be
    // rendered on the way. The source is still runtimePath — see createHarness.
    expect(fileSystem.writeFile).toHaveBeenCalledTimes(4);
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      new Path("/app-data/bin/ch-claude"),
      "claude-sh"
    );
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      new Path("/app-data/bin/ch-claude.cjs"),
      "claude-js"
    );
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      new Path("/app-data/bin/ch-claude.cmd"),
      "claude-cmd"
    );
    expect(fileSystem.writeFile).toHaveBeenCalledWith(new Path("/app-data/bin/code"), "code-sh");

    // Should make non-.cmd, non-.cjs files executable
    expect(fileSystem.makeExecutable).toHaveBeenCalledTimes(2);
    expect(fileSystem.makeExecutable).toHaveBeenCalledWith(new Path("/app-data/bin/ch-claude"));
    expect(fileSystem.makeExecutable).toHaveBeenCalledWith(new Path("/app-data/bin/code"));
  });

  it("writes nothing when every script is already up to date", async () => {
    // The regression this module exists for: on an ordinary launch the wrappers
    // are byte-identical, so nothing is deleted or rewritten and a wrapper held
    // open by a surviving agent process cannot fail startup.
    const fileSystem = createFakeFileSystem({
      files: {
        ...BUNDLED,
        "/app-data/bin/ch-claude": "claude-sh",
        "/app-data/bin/ch-claude.cjs": "claude-js",
        "/app-data/bin/ch-claude.cmd": "claude-cmd",
        "/app-data/bin/code": "code-sh",
      },
    });

    await createHarness(SCRIPTS, fileSystem).dispatch();

    expect(fileSystem.writeFile).not.toHaveBeenCalled();
    expect(fileSystem.rm).not.toHaveBeenCalled();
  });

  it("rewrites only the scripts whose content changed", async () => {
    const fileSystem = createFakeFileSystem({
      files: {
        ...BUNDLED,
        "/app-data/bin/ch-claude": "claude-sh",
        "/app-data/bin/ch-claude.cjs": "claude-js-OLD",
        "/app-data/bin/ch-claude.cmd": "claude-cmd",
        "/app-data/bin/code": "code-sh",
      },
    });

    await createHarness(SCRIPTS, fileSystem).dispatch();

    expect(fileSystem.writeFile).toHaveBeenCalledTimes(1);
    expect(fileSystem.writeFile).toHaveBeenCalledWith(
      new Path("/app-data/bin/ch-claude.cjs"),
      "claude-js"
    );
    expect(fileSystem.files.get("/app-data/bin/ch-claude.cjs")).toBe("claude-js");
  });

  describe("templated scripts", () => {
    it("renders a template before writing it", async () => {
      // The `ch` wrapper carries the bundled interpreter's path so the CLI runs
      // in a shell that inherited none of CodeHydra's environment.
      const fileSystem = createFakeFileSystem({
        files: { "/runtime/bin/ch": 'NODE="{{ ideNode }}"\nexec "$NODE" ch.cjs' },
      });

      await createHarness([{ name: "ch", template: true }], fileSystem).dispatch();

      expect(fileSystem.files.get("/app-data/bin/ch")).toBe(
        'NODE="/ide/node"\nexec "$NODE" ch.cjs'
      );
    });

    it("copies a non-template verbatim, braces and all", async () => {
      // Shell scripts contain real ${...} expansions; only declared templates
      // are rendered, so an undeclared one is never touched.
      const fileSystem = createFakeFileSystem({
        files: { "/runtime/bin/code": 'exec "$_CH_IDE_REMOTE_CLI" ${ARGS} "$@"' },
      });

      await createHarness(["code"], fileSystem).dispatch();

      expect(fileSystem.files.get("/app-data/bin/code")).toBe(
        'exec "$_CH_IDE_REMOTE_CLI" ${ARGS} "$@"'
      );
    });

    it("rewrites a template when its rendered content changes", async () => {
      // An IDE upgrade moves the interpreter; the same content-compare that
      // spares unchanged files must notice this one did change.
      const fileSystem = createFakeFileSystem({
        files: {
          "/runtime/bin/ch": 'NODE="{{ ideNode }}"',
          "/app-data/bin/ch": 'NODE="/old/ide/node"',
        },
      });

      await createHarness([{ name: "ch", template: true }], fileSystem).dispatch();

      expect(fileSystem.files.get("/app-data/bin/ch")).toBe('NODE="/ide/node"');
    });

    it("leaves a template alone when its rendered content is unchanged", async () => {
      const fileSystem = createFakeFileSystem({
        files: {
          "/runtime/bin/ch": 'NODE="{{ ideNode }}"',
          "/app-data/bin/ch": 'NODE="/ide/node"',
        },
      });

      await createHarness([{ name: "ch", template: true }], fileSystem).dispatch();

      expect(fileSystem.writeFile).not.toHaveBeenCalled();
    });
  });

  it("prunes entries that are no longer required", async () => {
    const fileSystem = createFakeFileSystem({
      files: {
        ...BUNDLED,
        "/app-data/bin/ch-claude": "claude-sh",
        "/app-data/bin/ch-claude.cjs": "claude-js",
        "/app-data/bin/ch-claude.cmd": "claude-cmd",
        "/app-data/bin/code": "code-sh",
        // Left over from a previous agent selection.
        "/app-data/bin/ch-opencode": "opencode-sh",
        "/app-data/bin/ch-opencode.cmd": "opencode-cmd",
      },
    });

    await createHarness(SCRIPTS, fileSystem).dispatch();

    expect(fileSystem.rm).toHaveBeenCalledTimes(2);
    expect(fileSystem.rm).toHaveBeenCalledWith(
      new Path("/app-data/bin/ch-opencode"),
      expect.objectContaining({ force: true })
    );
    expect(fileSystem.rm).toHaveBeenCalledWith(
      new Path("/app-data/bin/ch-opencode.cmd"),
      expect.objectContaining({ force: true })
    );
    expect(fileSystem.copyTree).not.toHaveBeenCalled();
  });

  it("does not fail startup when a stale script is locked", async () => {
    const fileSystem = createFakeFileSystem({
      files: {
        ...BUNDLED,
        "/app-data/bin/ch-claude": "claude-sh",
        "/app-data/bin/ch-claude.cjs": "claude-js",
        "/app-data/bin/ch-claude.cmd": "claude-cmd",
        "/app-data/bin/code": "code-sh",
        "/app-data/bin/ch-opencode.cmd": "opencode-cmd",
      },
    });
    fileSystem.rm.mockRejectedValue(
      new FileSystemError("EPERM", "/app-data/bin/ch-opencode.cmd", "EPERM: not permitted")
    );

    // Nothing requires the stale wrapper, so an undeletable one is only a warning.
    await expect(createHarness(SCRIPTS, fileSystem).dispatch()).resolves.toBeUndefined();
  });

  it("retries a locked write and succeeds when the lock clears", async () => {
    vi.useFakeTimers();
    try {
      const fileSystem = createFakeFileSystem({
        files: { ...BUNDLED, "/app-data/bin/ch-claude": "claude-sh-OLD" },
        binEntries: ["ch-claude"],
      });
      const realWriteFile = fileSystem.writeFile.getMockImplementation()!;
      fileSystem.writeFile
        .mockRejectedValueOnce(
          new FileSystemError("EPERM", "/app-data/bin/ch-claude", "EPERM: not permitted")
        )
        .mockImplementation(realWriteFile);

      const pending = createHarness(["ch-claude"], fileSystem).dispatch();
      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).resolves.toBeUndefined();
      expect(fileSystem.writeFile).toHaveBeenCalledTimes(2);
      expect(fileSystem.files.get("/app-data/bin/ch-claude")).toBe("claude-sh");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails startup with an actionable message when an outdated script stays locked", async () => {
    vi.useFakeTimers();
    try {
      const fileSystem = createFakeFileSystem({
        files: { ...BUNDLED, "/app-data/bin/ch-claude": "claude-sh-OLD" },
        binEntries: ["ch-claude"],
      });
      fileSystem.writeFile.mockRejectedValue(
        new FileSystemError("EPERM", "/app-data/bin/ch-claude", "EPERM: not permitted")
      );

      const pending = createHarness(["ch-claude"], fileSystem).dispatch();
      // Assert before advancing timers: an unhandled rejection otherwise escapes
      // while the retry loop is still sleeping.
      const assertion = expect(pending).rejects.toThrow(
        /Could not update the CodeHydra wrapper script "ch-claude".*previous CodeHydra session/s
      );
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;

      expect(fileSystem.writeFile).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails startup when a bundled script is missing from the runtime directory", async () => {
    // Packaging bug, not a lock — must not be silently tolerated.
    const fileSystem = createFakeFileSystem({ files: {} });

    await expect(createHarness(["ch-claude"], fileSystem).dispatch()).rejects.toThrow(/ENOENT/);
  });

  it("handles empty requiredScripts list", async () => {
    const fileSystem = createFakeFileSystem({ files: { ...BUNDLED } });

    await createHarness([], fileSystem).dispatch();

    expect(fileSystem.mkdir).toHaveBeenCalled();
    expect(fileSystem.copyTree).not.toHaveBeenCalled();
    expect(fileSystem.makeExecutable).not.toHaveBeenCalled();
  });
});
