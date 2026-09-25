// @vitest-environment node
/**
 * Integration tests for the lock module.
 *
 * Drives the table through its `Locks` surface and the lifecycle events the
 * module subscribes to, against the real SetMetadataOperation so the sidebar
 * tags are asserted where they land: in the workspace's metadata.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { registerTestInfrastructure } from "../intents/operations.test-utils";
import {
  SetMetadataOperation,
  SET_METADATA_OPERATION_ID,
  type SetMetadataIntent,
} from "../intents/set-metadata";
import { EVENT_WORKSPACE_CREATED } from "../intents/open-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { EVENT_WORKSPACE_HIBERNATED } from "../intents/hibernate-workspace";
import type { IntentModule } from "../intents/lib/module";
import type { HookContext } from "../intents/lib/operation";
import type { DomainEvent } from "../intents/lib/types";
import type { ProjectId, WorkspaceName } from "../shared/api/types";
import type { WorkspacePath } from "../intents/contract";
import type { LockKey, LockTakeOptions } from "../api/entries/deps";
import { ApiError } from "../api/errors";
import { projPath, wsPath } from "../shared/test-fixtures";
import { createLockModule, LOCK_TAG_KEY, LOCK_WAIT_TAG_KEY, type LockModule } from "./lock-module";

const PROJECT = projPath("/project");
const OTHER_PROJECT = projPath("/other");
const A = wsPath("/workspaces/alpha");
const B = wsPath("/workspaces/bravo");
const C = wsPath("/workspaces/charlie");

const DEVICE: LockKey = { name: "device", project: null };

interface Setup {
  readonly module: LockModule;
  readonly metadata: Map<string, Map<string, string>>;
  readonly writes: Array<{ workspacePath: WorkspacePath; key: string; value: string | null }>;
}

function setup(): Setup {
  const dispatcher = createMockDispatcher();
  const metadata = new Map<string, Map<string, string>>();
  const writes: Setup["writes"] = [];

  registerTestInfrastructure(dispatcher, {
    workspaces: (workspacePath: WorkspacePath) => ({
      projectPath: PROJECT,
      workspaceName: workspacePath.slice(workspacePath.lastIndexOf("/") + 1) as WorkspaceName,
    }),
    projects: { [PROJECT]: { projectId: "project-1" as ProjectId } },
  });
  dispatcher.registerOperation(new SetMetadataOperation());

  // Stands in for the git branch config the tags are stored in.
  const store: IntentModule = {
    name: "test-metadata-store",
    hooks: {
      [SET_METADATA_OPERATION_ID]: {
        set: {
          handler: async (ctx: HookContext): Promise<void> => {
            const { payload } = ctx.intent as SetMetadataIntent;
            writes.push({ ...payload });
            const entries = metadata.get(payload.workspacePath) ?? new Map<string, string>();
            if (payload.value === null) entries.delete(payload.key);
            else entries.set(payload.key, payload.value);
            metadata.set(payload.workspacePath, entries);
          },
        },
      },
    },
  };
  dispatcher.registerModule(store);

  const module = createLockModule({ dispatcher, logger: SILENT_LOGGER });
  dispatcher.registerModule(module);
  return { module, metadata, writes };
}

/** Options for a plain take on a connection that stays open. */
function opts(overrides: Partial<LockTakeOptions> = {}): LockTakeOptions {
  return {
    wait: true,
    signal: new AbortController().signal,
    releaseOnDisconnect: false,
    ...overrides,
  };
}

/** Let the tag write chains drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function tag(s: Setup, workspace: WorkspacePath, key: string): unknown {
  const raw = s.metadata.get(workspace)?.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
}

function emit(module: LockModule, type: string, payload: Record<string, unknown>): Promise<void> {
  const handler = module.events?.[type]?.handler;
  if (!handler) throw new Error(`lock module does not handle ${type}`);
  return handler({ type, payload } as DomainEvent);
}

describe("lock module", () => {
  describe("take and release", () => {
    it("grants a free lock at once and lists it", async () => {
      const s = setup();

      await expect(s.module.locks.take(A, DEVICE, opts({ reason: "smoke test" }))).resolves.toEqual(
        { acquired: true, waitedMs: 0 }
      );

      expect(s.module.locks.list()).toEqual([
        expect.objectContaining({
          name: "device",
          project: null,
          holder: A,
          reason: "smoke test",
          waiting: [],
        }),
      ]);
    });

    it("treats a re-take by the holder as a no-op that does not acquire", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts({ reason: "first" }));

      await expect(s.module.locks.take(A, DEVICE, opts({ reason: "second" }))).resolves.toEqual({
        acquired: false,
        waitedMs: 0,
      });
      // Nothing changes — not even the reason.
      expect(s.module.locks.list()[0]?.reason).toBe("first");
    });

    it("refuses with conflict, naming the holder, when told not to wait", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts({ reason: "pull crash logs" }));

      const refusal = s.module.locks.take(B, DEVICE, opts({ wait: false }));

      await expect(refusal).rejects.toBeInstanceOf(ApiError);
      await expect(refusal).rejects.toMatchObject({
        category: "conflict",
        message: expect.stringMatching(/'device' is held by 'alpha' \(\d+s\) — "pull crash logs"/),
      });
    });

    it("names the holder by its workspace name, not its directory", async () => {
      const s = setup();
      const slashed = wsPath("/workspaces/feature%x");
      await emit(s.module, EVENT_WORKSPACE_CREATED, {
        workspacePath: slashed,
        workspaceName: "feature/x",
        metadata: {},
      });
      await s.module.locks.take(slashed, DEVICE, opts());

      await expect(s.module.locks.take(B, DEVICE, opts({ wait: false }))).rejects.toMatchObject({
        message: expect.stringMatching(/'device' is held by 'feature\/x'/),
      });
    });

    it("hands the lock to waiters in arrival order", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      const order: string[] = [];
      const b = s.module.locks.take(B, DEVICE, opts()).then(() => order.push("bravo"));
      const c = s.module.locks.take(C, DEVICE, opts()).then(() => order.push("charlie"));

      expect(s.module.locks.list()[0]?.waiting).toEqual([B, C]);

      s.module.locks.release(A, DEVICE);
      await b;
      expect(s.module.locks.list()[0]?.holder).toBe(B);

      s.module.locks.release(B, DEVICE);
      await c;
      expect(order).toEqual(["bravo", "charlie"]);
    });

    it("drops the lock entirely when released with nobody waiting", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());

      s.module.locks.release(A, DEVICE);

      expect(s.module.locks.list()).toEqual([]);
    });

    it("refuses to release a lock the workspace does not hold", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());

      expect(() => s.module.locks.release(B, DEVICE)).toThrow(
        expect.objectContaining({
          category: "not-found",
          message: "'device' is not held by this workspace (held by 'alpha').",
        })
      );
      expect(() => s.module.locks.release(B, { name: "nothing", project: null })).toThrow(
        expect.objectContaining({ category: "not-found" })
      );
    });

    it("resolves the holder's own queued takes as re-takes once it is granted", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      const first = s.module.locks.take(B, DEVICE, opts());
      const second = s.module.locks.take(B, DEVICE, opts());

      s.module.locks.release(A, DEVICE);

      await expect(first).resolves.toMatchObject({ acquired: true });
      await expect(second).resolves.toMatchObject({ acquired: false });
      expect(s.module.locks.list()[0]?.waiting).toEqual([]);
    });

    it("keeps the global and a project namespace apart", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());

      await expect(
        s.module.locks.take(B, { name: "device", project: PROJECT }, opts({ wait: false }))
      ).resolves.toMatchObject({ acquired: true });
      await expect(
        s.module.locks.take(C, { name: "device", project: OTHER_PROJECT }, opts({ wait: false }))
      ).resolves.toMatchObject({ acquired: true });
      expect(s.module.locks.list()).toHaveLength(3);
    });
  });

  describe("caller disconnects", () => {
    it("removes a queued waiter whose caller went away", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      const connection = new AbortController();
      const waiting = s.module.locks.take(B, DEVICE, opts({ signal: connection.signal }));

      connection.abort();

      await expect(waiting).rejects.toMatchObject({ category: "failed" });
      expect(s.module.locks.list()[0]?.waiting).toEqual([]);
      // And the lock is not later granted to the workspace nobody is waiting in.
      s.module.locks.release(A, DEVICE);
      expect(s.module.locks.list()).toEqual([]);
    });

    it("releases a hold tied to its connection when that connection closes", async () => {
      const s = setup();
      const connection = new AbortController();
      await s.module.locks.take(
        A,
        DEVICE,
        opts({ signal: connection.signal, releaseOnDisconnect: true })
      );
      const next = s.module.locks.take(B, DEVICE, opts());

      connection.abort();

      await expect(next).resolves.toMatchObject({ acquired: true });
      expect(s.module.locks.list()[0]?.holder).toBe(B);
    });

    it("keeps an ordinary take after its connection closes", async () => {
      const s = setup();
      const connection = new AbortController();
      await s.module.locks.take(A, DEVICE, opts({ signal: connection.signal }));

      connection.abort();

      expect(s.module.locks.list()[0]?.holder).toBe(A);
    });

    it("releases nothing when the connection closes after the hold already ended", async () => {
      const s = setup();
      const connection = new AbortController();
      await s.module.locks.take(
        A,
        DEVICE,
        opts({ signal: connection.signal, releaseOnDisconnect: true })
      );
      s.module.locks.release(A, DEVICE);
      await s.module.locks.take(B, DEVICE, opts());

      connection.abort();

      expect(s.module.locks.list()[0]?.holder).toBe(B);
    });
  });

  describe("workspace lifecycle", () => {
    it("releases on hibernation, hands over, and drops the workspace's queued takes", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      await s.module.locks.take(B, { name: "gpu", project: null }, opts());
      const next = s.module.locks.take(B, DEVICE, opts());
      const dropped = s.module.locks.take(A, { name: "gpu", project: null }, opts());

      await emit(s.module, EVENT_WORKSPACE_HIBERNATED, { workspacePath: A });

      await expect(next).resolves.toMatchObject({ acquired: true });
      await expect(dropped).rejects.toMatchObject({
        message: "The workspace was hibernated while waiting.",
      });
      expect(s.module.locks.list().map((l) => [l.name, l.holder, l.waiting])).toEqual([
        ["device", B, []],
        ["gpu", B, []],
      ]);
    });

    it("releases on deletion without writing tags into the deleted workspace", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      await settle();
      s.writes.length = 0;

      await emit(s.module, EVENT_WORKSPACE_DELETED, { workspacePath: A });
      await settle();

      expect(s.module.locks.list()).toEqual([]);
      expect(s.writes.filter((w) => w.workspacePath === A)).toEqual([]);
    });
  });

  describe("sidebar tags", () => {
    it("labels what a workspace holds, with the reasons as the tooltip", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts({ reason: "pull crash logs" }));
      await s.module.locks.take(A, { name: "staging_db", project: null }, opts());
      await settle();

      // No color (bare text, not a pill) and no age (it would go stale).
      expect(tag(s, A, LOCK_TAG_KEY)).toEqual({
        label: "🔒 device, staging_db",
        description: "device — pull crash logs\nstaging_db",
      });
    });

    it("labels what a workspace waits for, naming the holder", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts({ reason: "gradle install" }));
      void s.module.locks.take(B, DEVICE, opts());
      await settle();

      expect(tag(s, B, LOCK_WAIT_TAG_KEY)).toEqual({
        label: "⏳ device",
        description: "device — held by 'alpha' — \"gradle install\"",
      });
    });

    it("moves the tags when the lock changes hands", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      const next = s.module.locks.take(B, DEVICE, opts());
      await settle();

      s.module.locks.release(A, DEVICE);
      await next;
      await settle();

      expect(tag(s, A, LOCK_TAG_KEY)).toBeUndefined();
      expect(tag(s, B, LOCK_WAIT_TAG_KEY)).toBeUndefined();
      expect(tag(s, B, LOCK_TAG_KEY)).toEqual({ label: "🔒 device", description: "device" });
    });

    it("writes nothing when a change leaves a workspace's tags as they were", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      await settle();
      const before = s.writes.length;

      await s.module.locks.take(A, DEVICE, opts()); // re-take: no change
      await settle();

      expect(s.writes.length).toBe(before);
    });

    it("clears tags a previous run left behind when the workspace is discovered", async () => {
      const s = setup();
      const stale = JSON.stringify({ label: "🔒 device", description: "device" });
      s.metadata.set(A, new Map([[LOCK_TAG_KEY, stale]]));

      await emit(s.module, EVENT_WORKSPACE_CREATED, {
        workspacePath: A,
        metadata: { [LOCK_TAG_KEY]: stale },
      });
      await settle();

      expect(tag(s, A, LOCK_TAG_KEY)).toBeUndefined();
    });

    it("keeps the tag of a lock actually held when the workspace is rediscovered", async () => {
      const s = setup();
      await s.module.locks.take(A, DEVICE, opts());
      await settle();
      const current = s.metadata.get(A)?.get(LOCK_TAG_KEY);

      await emit(s.module, EVENT_WORKSPACE_CREATED, {
        workspacePath: A,
        metadata: { [LOCK_TAG_KEY]: current },
      });
      await settle();

      expect(s.metadata.get(A)?.get(LOCK_TAG_KEY)).toBe(current);
    });
  });
});
