// @vitest-environment node
/**
 * Integration tests for WindowTitleModule through the Dispatcher.
 *
 * Tests verify the full pipeline:
 * dispatcher -> operation -> domain event -> WindowTitleModule -> setTitle()
 *
 * Uses minimal operations that emit workspace:switched.
 */

import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { describe, it, expect, vi } from "vitest";
import { Dispatcher } from "../intents/lib/dispatcher";

import { z } from "zod/v4";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import type { WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import { EVENT_METADATA_CHANGED } from "../intents/set-metadata";
import type { MetadataChangedEvent } from "../intents/set-metadata";
import type { Operation, OperationSchemas } from "../intents/lib/operation";
import { createMinimalOperation } from "../intents/lib/operation.test-utils";
import type { Intent } from "../intents/lib/types";
import {
  APP_START_OPERATION_ID,
  INTENT_APP_START,
  type AppStartIntent,
} from "../intents/app-start";
import { createWindowTitleModule } from "./window-title-module";
import type { ProjectId, WorkspaceName } from "../shared/api/types";

// =============================================================================
// Minimal switch operation that emits workspace:switched
// =============================================================================

const INTENT_MINIMAL_SWITCH = "workspace:switch" as const;

interface MinimalSwitchPayload {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly workspaceName: WorkspaceName;
  readonly path: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface MinimalSwitchIntent extends Intent<void> {
  readonly type: typeof INTENT_MINIMAL_SWITCH;
  readonly payload: MinimalSwitchPayload | null;
}

const minimalSwitchSchemas = {
  type: INTENT_MINIMAL_SWITCH,
  payload: z.unknown(),
} satisfies OperationSchemas;

const minimalSwitchOperation: Operation<typeof minimalSwitchSchemas> = {
  id: "switch-workspace",
  schemas: minimalSwitchSchemas,
  async execute(ctx): Promise<void> {
    const payload = ctx.intent.payload as MinimalSwitchPayload | null;

    const event: WorkspaceSwitchedEvent = {
      type: EVENT_WORKSPACE_SWITCHED,
      payload: payload
        ? {
            projectId: payload.projectId,
            projectName: payload.projectName,
            projectPath: "/projects/test",
            workspaceName: payload.workspaceName,
            path: payload.path,
            metadata: payload.metadata ?? {},
          }
        : null,
    };
    ctx.emit(event);
  },
};

// =============================================================================
// Minimal set-metadata operation that emits workspace:metadata-changed
// =============================================================================

const INTENT_MINIMAL_SET_METADATA = "workspace:set-metadata" as const;

interface MinimalSetMetadataPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly workspacePath: string;
  readonly key: string;
  readonly value: string | null;
}

interface MinimalSetMetadataIntent extends Intent<void> {
  readonly type: typeof INTENT_MINIMAL_SET_METADATA;
  readonly payload: MinimalSetMetadataPayload;
}

const minimalSetMetadataSchemas = {
  type: INTENT_MINIMAL_SET_METADATA,
  payload: z.unknown(),
} satisfies OperationSchemas;

const minimalSetMetadataOperation: Operation<typeof minimalSetMetadataSchemas> = {
  id: "set-metadata",
  schemas: minimalSetMetadataSchemas,
  async execute(ctx): Promise<void> {
    const payload = ctx.intent.payload as MinimalSetMetadataPayload;

    const event: MetadataChangedEvent = {
      type: EVENT_METADATA_CHANGED,
      payload: {
        projectId: payload.projectId,
        workspaceName: payload.workspaceName,
        workspacePath: payload.workspacePath,
        key: payload.key,
        value: payload.value,
      },
    };
    ctx.emit(event);
  },
};

// =============================================================================
// Test Setup
// =============================================================================

interface TestSetup {
  dispatcher: Dispatcher;
  setTitle: ReturnType<typeof vi.fn>;
}

function createTestSetup(titleVersion?: string): TestSetup {
  const setTitle = vi.fn();

  const dispatcher = createMockDispatcher();

  dispatcher.registerOperation(minimalSwitchOperation);
  dispatcher.registerOperation(minimalSetMetadataOperation);
  dispatcher.registerOperation(
    createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start")
  );

  const windowTitleModule = createWindowTitleModule({
    windowManager: { setTitle },
    titleVersion: titleVersion ?? "main",
  });

  dispatcher.registerModule(windowTitleModule);

  return { dispatcher, setTitle };
}

function switchIntent(payload: MinimalSwitchPayload | null): MinimalSwitchIntent {
  return {
    type: INTENT_MINIMAL_SWITCH,
    payload,
  };
}

function startIntent(): AppStartIntent {
  return {
    type: INTENT_APP_START,
    payload: {} as AppStartIntent["payload"],
  };
}

function setMetadataIntent(payload: MinimalSetMetadataPayload): MinimalSetMetadataIntent {
  return {
    type: INTENT_MINIMAL_SET_METADATA,
    payload,
  };
}

/** The active workspace used by the title/rename tests. */
const ACTIVE: MinimalSwitchPayload = {
  projectId: "test-project" as ProjectId,
  projectName: "MyProject",
  workspaceName: "feature-branch" as WorkspaceName,
  path: "/workspaces/feature-branch",
};

// =============================================================================
// Tests
// =============================================================================

describe("WindowTitleModule Integration", () => {
  it("sets title with workspace/project on workspace switch", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(switchIntent(ACTIVE));

    expect(setTitle).toHaveBeenCalledWith("feature-branch / MyProject - CodeHydra (main)");
  });

  it("prefixes the user-given title when the switched workspace has one", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(switchIntent({ ...ACTIVE, metadata: { title: "Fix login bug" } }));

    expect(setTitle).toHaveBeenCalledWith(
      "Fix login bug / feature-branch / MyProject - CodeHydra (main)"
    );
  });

  it("ignores metadata other than the title on switch", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(
      switchIntent({ ...ACTIVE, metadata: { hibernated: "true", "tags.wip": "{}" } })
    );

    expect(setTitle).toHaveBeenCalledWith("feature-branch / MyProject - CodeHydra (main)");
  });

  it("treats a blank title as unset, falling back to the workspace name", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(switchIntent({ ...ACTIVE, metadata: { title: "   " } }));

    expect(setTitle).toHaveBeenCalledWith("feature-branch / MyProject - CodeHydra (main)");
  });

  it("sets title with no-workspace format on null payload", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(switchIntent(null));

    expect(setTitle).toHaveBeenCalledWith("CodeHydra (main)");
  });

  it("drops a stale title when switching to a workspace without one", async () => {
    const { dispatcher, setTitle } = createTestSetup();

    await dispatcher.dispatch(switchIntent({ ...ACTIVE, metadata: { title: "Fix login bug" } }));
    await dispatcher.dispatch(
      switchIntent({
        ...ACTIVE,
        workspaceName: "other-branch" as WorkspaceName,
        path: "/workspaces/other-branch",
      })
    );

    expect(setTitle).toHaveBeenLastCalledWith("other-branch / MyProject - CodeHydra (main)");
  });

  it("sets initial title with version during app:start", async () => {
    const { dispatcher, setTitle } = createTestSetup("1.0.0");

    await dispatcher.dispatch(startIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra (1.0.0)");
  });

  it("sets initial title with dev branch during app:start", async () => {
    const { dispatcher, setTitle } = createTestSetup("my-branch");

    await dispatcher.dispatch(startIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra (my-branch)");
  });

  it("sets initial title without version when titleVersion is undefined", async () => {
    const setTitle = vi.fn();
    const dispatcher = createMockDispatcher();

    dispatcher.registerOperation(
      createMinimalOperation(APP_START_OPERATION_ID, INTENT_APP_START, "start")
    );

    const windowTitleModule = createWindowTitleModule({
      windowManager: { setTitle },
      titleVersion: undefined,
    });
    dispatcher.registerModule(windowTitleModule);

    await dispatcher.dispatch(startIntent());

    expect(setTitle).toHaveBeenCalledWith("CodeHydra");
  });

  describe("retitling the active workspace (no workspace:switched is emitted)", () => {
    it("adopts a title set on the active workspace", async () => {
      const { dispatcher, setTitle } = createTestSetup();
      await dispatcher.dispatch(switchIntent(ACTIVE));

      await dispatcher.dispatch(
        setMetadataIntent({
          projectId: ACTIVE.projectId,
          workspaceName: ACTIVE.workspaceName,
          workspacePath: ACTIVE.path,
          key: "title",
          value: "Fix login bug",
        })
      );

      expect(setTitle).toHaveBeenLastCalledWith(
        "Fix login bug / feature-branch / MyProject - CodeHydra (main)"
      );
    });

    it("reverts to the workspace name when the title is cleared", async () => {
      const { dispatcher, setTitle } = createTestSetup();
      await dispatcher.dispatch(switchIntent({ ...ACTIVE, metadata: { title: "Fix login bug" } }));

      await dispatcher.dispatch(
        setMetadataIntent({
          projectId: ACTIVE.projectId,
          workspaceName: ACTIVE.workspaceName,
          workspacePath: ACTIVE.path,
          key: "title",
          value: null,
        })
      );

      expect(setTitle).toHaveBeenLastCalledWith("feature-branch / MyProject - CodeHydra (main)");
    });

    it("ignores a title set on a different workspace", async () => {
      const { dispatcher, setTitle } = createTestSetup();
      await dispatcher.dispatch(switchIntent(ACTIVE));
      setTitle.mockClear();

      await dispatcher.dispatch(
        setMetadataIntent({
          projectId: ACTIVE.projectId,
          workspaceName: "other-branch" as WorkspaceName,
          workspacePath: "/workspaces/other-branch",
          key: "title",
          value: "Someone else",
        })
      );

      expect(setTitle).not.toHaveBeenCalled();
    });

    it("ignores a same-named workspace in a different project", async () => {
      const { dispatcher, setTitle } = createTestSetup();
      await dispatcher.dispatch(switchIntent(ACTIVE));
      setTitle.mockClear();

      await dispatcher.dispatch(
        setMetadataIntent({
          projectId: "other-project" as ProjectId,
          workspaceName: ACTIVE.workspaceName,
          workspacePath: "/other/feature-branch",
          key: "title",
          value: "Someone else",
        })
      );

      expect(setTitle).not.toHaveBeenCalled();
    });

    it("ignores metadata changes other than the title", async () => {
      const { dispatcher, setTitle } = createTestSetup();
      await dispatcher.dispatch(switchIntent(ACTIVE));
      setTitle.mockClear();

      await dispatcher.dispatch(
        setMetadataIntent({
          projectId: ACTIVE.projectId,
          workspaceName: ACTIVE.workspaceName,
          workspacePath: ACTIVE.path,
          key: "tags.wip",
          value: "{}",
        })
      );

      expect(setTitle).not.toHaveBeenCalled();
    });

    it("ignores a title change while no workspace is active", async () => {
      const { dispatcher, setTitle } = createTestSetup();
      await dispatcher.dispatch(switchIntent(null));
      setTitle.mockClear();

      await dispatcher.dispatch(
        setMetadataIntent({
          projectId: ACTIVE.projectId,
          workspaceName: ACTIVE.workspaceName,
          workspacePath: ACTIVE.path,
          key: "title",
          value: "Fix login bug",
        })
      );

      expect(setTitle).not.toHaveBeenCalled();
    });
  });
});
