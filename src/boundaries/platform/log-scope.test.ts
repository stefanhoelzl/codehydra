/**
 * Focused tests for the ambient log scope helpers: rendering, the store, a
 * logger with a fixed scope, and the context filters that keep `scope.*` and
 * target-path repeats out of a line's own context.
 */

import { describe, it, expect } from "vitest";
import { AsyncLogScopeStore, formatLogScope, ScopedLogger } from "./log-scope";
import { toLogContext } from "./logging-types";
import { testPath } from "../../shared/test-fixtures";
import { makeWorkspaceRef, projectRefFor } from "../../utils/ref";
import type { LogContext, Logger, LogScope } from "./logging-types";

describe("formatLogScope", () => {
  it("renders every part in its position", () => {
    expect(
      formatLogScope({
        trace: "7f3a01",
        project: "proj",
        ws: "feat",
        intent: "workspace:switch",
        module: "git-worktree",
        hook: "create",
        origin: "cli",
      })
    ).toBe("[7f3a01 proj/feat workspace:switch@git-worktree/create cli]");
  });

  it("leaves empty parts out", () => {
    expect(formatLogScope({ trace: "7f3a01", intent: "project:list" })).toBe(
      "[7f3a01 project:list]"
    );
  });

  it("keeps the slash of a project without a workspace, so it cannot read as an origin", () => {
    expect(
      formatLogScope({ trace: "7f3a01", project: "proj", intent: "project:open", origin: "ui" })
    ).toBe("[7f3a01 proj/ project:open ui]");
  });

  it("does not render caller, api or path", () => {
    expect(
      formatLogScope({ trace: "7f3a01", caller: "proj/me", api: "workspace.delete", path: "/x" })
    ).toBe("[7f3a01]");
  });

  it("renders nothing for no scope", () => {
    expect(formatLogScope(undefined)).toBe("");
    expect(formatLogScope({})).toBe("");
  });
});

describe("AsyncLogScopeStore", () => {
  it("reads the scope through the reader on every access", async () => {
    const store = new AsyncLogScopeStore();
    let ws = "a";
    await store.run(
      () => ({ ws }),
      async () => {
        expect(store.current()).toEqual({ ws: "a" });
        ws = "b";
        await Promise.resolve();
        expect(store.current()).toEqual({ ws: "b" });
      }
    );
    expect(store.current()).toBeUndefined();
  });
});

describe("AsyncLogScopeStore workspace names", () => {
  it("finds the workspace a path is, or the deepest one it lies inside", () => {
    const store = new AsyncLogScopeStore();
    const outer = testPath("/ws/a").toString();
    const nested = testPath("/ws/a/nested").toString();
    store.nameWorkspace(outer, { project: "proj", ws: "a" });
    store.nameWorkspace(nested, { project: "proj", ws: "n" });

    expect(store.workspaceAt(outer)).toEqual({ project: "proj", ws: "a", path: outer });
    expect(store.workspaceAt(testPath("/ws/a/src/x.ts").toString())?.ws).toBe("a");
    expect(store.workspaceAt(testPath("/ws/a/nested/deep").toString())?.ws).toBe("n");
    expect(store.workspaceAt(testPath("/ws/ab").toString())).toBeUndefined();
    expect(store.workspaceAt("relative/path")).toBeUndefined();
  });
});

describe("ScopedLogger", () => {
  const ws = testPath("/ws/a").toString();
  const other = testPath("/ws/b").toString();

  function setup(): {
    store: AsyncLogScopeStore;
    seen: { context: LogContext | undefined; scope: LogScope | undefined }[];
    logger: Logger;
  } {
    const store = new AsyncLogScopeStore();
    const seen: { context: LogContext | undefined; scope: LogScope | undefined }[] = [];
    const record = (_message: string, context?: LogContext): void => {
      seen.push({ context, scope: store.current() });
    };
    const logger: Logger = {
      silly: record,
      debug: record,
      info: record,
      warn: record,
      error: record,
      scoped: (hint) => new ScopedLogger(logger, store, hint),
    };
    return { store, seen, logger };
  }

  it("shows a named workspace by name, with no path", () => {
    const { store, seen, logger } = setup();
    store.nameWorkspace(ws, { project: "proj", ws: "a" });

    logger.scoped({ path: ws }).info("m", { n: 1 });

    expect(seen).toEqual([{ context: { n: 1 }, scope: { project: "proj", ws: "a", path: ws } }]);
  });

  it("shows a path inside a workspace relative to it", () => {
    const { store, seen, logger } = setup();
    store.nameWorkspace(ws, { project: "proj", ws: "a" });

    logger.scoped({ path: testPath("/ws/a/.codehydra/hooks").toString() }).info("m");

    expect(seen[0]?.context).toEqual({ path: ".codehydra/hooks" });
    expect(seen[0]?.scope?.ws).toBe("a");
  });

  it("keeps the ambient trace and intent, and replaces its workspace", () => {
    const { store, seen, logger } = setup();
    store.nameWorkspace(other, { project: "proj", ws: "b" });

    store.run(
      () => ({ trace: "7f3a01", intent: "workspace:switch", project: "proj", ws: "a", path: ws }),
      () => logger.scoped({ path: other }).info("m")
    );

    expect(seen[0]?.scope).toEqual({
      trace: "7f3a01",
      intent: "workspace:switch",
      project: "proj",
      ws: "b",
      path: other,
    });
  });

  it("uses the ambient workspace for a path inside it before the index names it", () => {
    const { store, seen, logger } = setup();

    store.run(
      () => ({ trace: "7f3a01", project: "proj", ws: "a", path: ws }),
      () => logger.scoped({ path: testPath("/ws/a/src").toString() }).info("m")
    );

    expect(seen[0]).toEqual({
      context: { path: "src" },
      scope: { trace: "7f3a01", project: "proj", ws: "a", path: ws },
    });
  });

  it("claims no workspace for a path outside every known one, not even the ambient", () => {
    const { store, seen, logger } = setup();

    store.run(
      () => ({ trace: "7f3a01", project: "proj", ws: "a", path: ws }),
      () => logger.scoped({ path: other }).info("m")
    );

    expect(seen[0]).toEqual({ context: { path: other }, scope: { trace: "7f3a01" } });
  });

  it("lets an explicit path key win, and adds the origin", () => {
    const { seen, logger } = setup();

    logger.scoped({ path: other, origin: "sidekick" }).info("m", { path: "/elsewhere" });

    expect(seen[0]).toEqual({ context: { path: "/elsewhere" }, scope: { origin: "sidekick" } });
  });

  it("names the project and workspace from a workspace ref, replacing the ambient one", () => {
    const { store, seen, logger } = setup();
    const ref = makeWorkspaceRef(projectRefFor(testPath("/repos/proj").toString()), "feat");

    store.run(
      () => ({ trace: "7f3a01", intent: "workspace:switch", project: "proj", ws: "a", path: ws }),
      () => logger.scoped({ workspace: ref, origin: "sidekick" }).info("m", { n: 1 })
    );

    expect(seen[0]).toEqual({
      context: { n: 1 },
      scope: {
        trace: "7f3a01",
        intent: "workspace:switch",
        project: "proj",
        ws: "feat",
        origin: "sidekick",
      },
    });
  });

  it("lets a path hint win over a workspace ref", () => {
    const { store, seen, logger } = setup();
    store.nameWorkspace(ws, { project: "proj", ws: "a" });
    const ref = makeWorkspaceRef(projectRefFor(testPath("/repos/proj").toString()), "feat");

    logger.scoped({ workspace: ref, path: ws }).info("m");

    expect(seen[0]?.scope).toEqual({ project: "proj", ws: "a", path: ws });
  });

  it("merges the hints of a scoped logger scoped again", () => {
    const { store, seen, logger } = setup();
    store.nameWorkspace(ws, { project: "proj", ws: "a" });

    logger.scoped({ origin: "sidekick" }).scoped({ path: ws }).info("m");

    expect(seen[0]?.scope).toEqual({ project: "proj", ws: "a", path: ws, origin: "sidekick" });
  });
});

describe("toLogContext", () => {
  it("drops scope.* keys a runtime record carries", () => {
    const record: Record<string, string> = { "scope.ws": "spoofed", message: "hi" };
    expect(toLogContext(record)).toEqual({ message: "hi" });
  });
});
