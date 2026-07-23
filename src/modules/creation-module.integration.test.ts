// @vitest-environment node
/**
 * Integration tests for CreationModule (behavioral mocks).
 *
 * The module owns the "New workspace" form session on the panel surface:
 * always-alive (opened on app:started), reset on dismiss, project-row
 * side-flows (folder-open via project:open, git-clone via a modal
 * sub-dialog), two-phase branch loading, per-field validation, and submit
 * (workspace:open with source "creation").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SILENT_LOGGER } from "../boundaries/platform/logging.test-utils";
import { createMockAccessor } from "../boundaries/platform/config.test-utils";
import { createCreationModule, validateCloneUrl } from "./creation-module";
import type { CreationModuleDeps } from "./creation-module";
import type { IntentModule } from "../intents/lib/module";
import { createMockDialogManager } from "./presentation/dialog-manager.state-mock";
import type { MockDialogHandle } from "./presentation/dialog-manager.state-mock";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogConfig, DialogSection } from "../shared/dialog-types";
import type { ConfigAgentType } from "../boundaries/platform/config";
import type { Project, ProjectId, WorkspaceName, BaseInfo } from "../shared/api/types";
import type { AgentInfo } from "../shared/ipc";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import {
  EVENT_PROJECT_OPENED,
  EVENT_CLONE_PROGRESS,
  INTENT_OPEN_PROJECT,
} from "../intents/open-project";
import { EVENT_PROJECT_CLOSED } from "../intents/close-project";
import { EVENT_BASES_UPDATED, INTENT_GET_PROJECT_BASES } from "../intents/get-project-bases";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { INTENT_OPEN_WORKSPACE } from "../intents/open-workspace";
import { INTENT_LIST_PROJECTS } from "../intents/list-projects";
import { INTENT_GET_LAUNCH_OPTIONS } from "../intents/agent-launch-options";
import { wsPath, projPath } from "../shared/test-fixtures";

// =============================================================================
// Fixtures
// =============================================================================

const PROJECT_A: Project = {
  id: "project-a-12345678" as ProjectId,
  name: "project-a",
  path: projPath("/projects/a"),
  workspaces: [
    {
      projectId: "project-a-12345678" as ProjectId,
      name: "existing" as WorkspaceName,
      branch: "existing",
      metadata: {},
      path: wsPath("/projects/a/.worktrees/existing"),
    },
  ],
};

const PROJECT_B: Project = {
  id: "project-b-12345678" as ProjectId,
  name: "project-b",
  path: projPath("/projects/b"),
  workspaces: [],
};

const BASES_A: readonly BaseInfo[] = [
  { name: "main", isRemote: false, derives: "main" },
  { name: "origin/feature-x", isRemote: true, base: "origin/feature-x", derives: "feature-x" },
];

const CLAUDE_AGENT: AgentInfo = { agent: "claude", label: "Claude Code", icon: "claude" };
const OPENCODE_AGENT: AgentInfo = { agent: "opencode", label: "OpenCode", icon: "opencode" };

/** A non-null workspace:switched payload for a project (active-surface bookkeeping). */
function switchedPayload(project: Project): Record<string, unknown> {
  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    workspaceName: "active" as WorkspaceName,
    path: `${project.path}/.worktrees/active`,
  };
}

// =============================================================================
// Mock Dispatcher (programmable per-intent results)
// =============================================================================

interface MockDispatcher {
  dispatcher: Dispatcher;
  dispatched: Array<{ type: string; payload: unknown }>;
  results: Map<string, (payload: unknown) => unknown>;
  byType(type: string): Array<{ type: string; payload: unknown }>;
}

function createDispatcher(): MockDispatcher {
  const dispatched: Array<{ type: string; payload: unknown }> = [];
  const results = new Map<string, (payload: unknown) => unknown>();
  const dispatch = vi.fn((intent: { type: string; payload: unknown }) => {
    dispatched.push(intent);
    const handler = results.get(intent.type);
    return Promise.resolve(handler ? handler(intent.payload) : undefined);
  });
  return {
    dispatcher: { dispatch } as unknown as Dispatcher,
    dispatched,
    results,
    byType: (type) => dispatched.filter((d) => d.type === type),
  };
}

// =============================================================================
// Config helpers
// =============================================================================

function sectionById(config: DialogConfig, id: string): DialogSection | undefined {
  for (const section of config.sections) {
    if ("id" in section && section.id === id) return section;
    if (section.type === "group") {
      for (const item of section.items) {
        if (item.id === id) return item as unknown as DialogSection;
      }
    }
  }
  return undefined;
}

function field(config: DialogConfig, id: string): Record<string, unknown> {
  const section = sectionById(config, id);
  expect(section, `section "${id}"`).toBeDefined();
  return section as unknown as Record<string, unknown>;
}

function suggestionValues(section: Record<string, unknown>): string[] {
  const groups = section["suggestions"] as Array<{ items: Array<{ value: string }> }>;
  return groups.flatMap((g) => g.items.map((i) => i.value));
}

/** The footer's cancel-role button (the one Escape clicks), or undefined. */
function cancelButton(config: DialogConfig): { id: string } | undefined {
  for (const section of config.sections) {
    if (section.type !== "group") continue;
    for (const item of section.items) {
      if (item.type === "button" && item.role === "cancel") return item;
    }
  }
  return undefined;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// =============================================================================
// Test setup
// =============================================================================

interface Setup {
  module: IntentModule;
  dialogs: ReturnType<typeof createMockDialogManager>;
  dispatcher: MockDispatcher;
  openUrl: ReturnType<typeof vi.fn>;
  emit(eventType: string, payload?: unknown): Promise<void>;
  start(): Promise<MockDialogHandle>;
}

function setup(options?: {
  projects?: Project[];
  bases?: readonly BaseInfo[];
  defaultBaseBranch?: string;
  activeWorkspaceProjectId?: ProjectId | null;
  agents?: readonly AgentInfo[];
  defaultAgent?: ConfigAgentType;
}): Setup {
  const dialogs = createMockDialogManager();
  const dispatcher = createDispatcher();
  const openUrl = vi.fn().mockResolvedValue(undefined);

  const projects = options?.projects ?? [PROJECT_A];
  dispatcher.results.set(INTENT_LIST_PROJECTS, () => projects);
  dispatcher.results.set(INTENT_GET_PROJECT_BASES, (payload) => {
    const p = payload as { projectPath: string };
    return {
      bases: options?.bases ?? BASES_A,
      ...(options?.defaultBaseBranch !== undefined && {
        defaultBaseBranch: options.defaultBaseBranch,
      }),
      projectPath: p.projectPath,
      projectId: PROJECT_A.id,
    };
  });
  dispatcher.results.set(INTENT_GET_LAUNCH_OPTIONS, (payload) => {
    // Mirror real backends: Claude reports permission modes, OpenCode none.
    const backend = (payload as { backend: string }).backend;
    return {
      permissionModes: backend === "claude" ? ["plan", "acceptEdits", "bypassPermissions"] : [],
    };
  });

  const deps: CreationModuleDeps = {
    ui: dialogs.ui,
    dispatcher: dispatcher.dispatcher,
    appBoundary: { openUrl },
    agentConfig: createMockAccessor<ConfigAgentType>("agent", options?.defaultAgent ?? "claude"),
    getAvailableAgents: vi.fn().mockResolvedValue(options?.agents ?? [CLAUDE_AGENT]),
    logger: SILENT_LOGGER,
  };
  const module = createCreationModule(deps);

  const emit = async (eventType: string, payload: unknown = {}): Promise<void> => {
    const declaration = module.events?.[eventType];
    expect(declaration, `event handler for ${eventType}`).toBeDefined();
    await declaration!.handler({ type: eventType, payload } as never);
    await flush();
  };

  const start = async (): Promise<MockDialogHandle> => {
    // Mirror the real restore-switch that lands before app:started: the
    // creation module records the active workspace's project from this event
    // (it no longer queries a live active ref, which the panel-open deselect
    // would null before the seed reads it).
    const activeId = options?.activeWorkspaceProjectId;
    if (activeId !== null && activeId !== undefined) {
      const active = projects.find((p) => p.id === activeId);
      if (active !== undefined) await emit(EVENT_WORKSPACE_SWITCHED, switchedPayload(active));
    }
    await emit(EVENT_APP_STARTED);
    const panel = dialogs.modelessHandles().find((h) => !h.closed);
    expect(panel, "open creation session").toBeDefined();
    return panel!;
  };

  return { module, dialogs, dispatcher, openUrl, emit, start };
}

/** The currently open (non-closed) creation session. */
function currentPanel(s: Setup): MockDialogHandle {
  const panel = s.dialogs.modelessHandles().find((h) => !h.closed);
  expect(panel, "open creation session").toBeDefined();
  return panel!;
}

// =============================================================================
// Tests
// =============================================================================

describe("CreationModule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("session lifecycle", () => {
    it("opens the panel session on app:started, seeded with the active workspace's project", async () => {
      const s = setup({
        projects: [PROJECT_B, PROJECT_A],
        activeWorkspaceProjectId: PROJECT_A.id,
      });
      const panel = await s.start();

      expect(panel.kind).toBe("modeless");
      const project = field(panel.config, "project");
      expect(project["value"]).toBe(PROJECT_A.path);
      expect(suggestionValues(project)).toEqual([PROJECT_B.path, PROJECT_A.path]);
      // Heading + form layout
      expect(panel.config.layout).toBe("form");
      expect(panel.config.sections[0]).toEqual({
        type: "text",
        content: "New workspace",
        style: "heading",
      });
    });

    it("falls back to the first project when no workspace is active", async () => {
      const s = setup({ projects: [PROJECT_B, PROJECT_A], activeWorkspaceProjectId: null });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.path);
    });

    it("keeps seeding the last active project across the panel-open deselect", async () => {
      // PROJECT_A is active but is NOT projects[0] — proves the seed follows the
      // active workspace, not the list head.
      const s = setup({ projects: [PROJECT_B, PROJECT_A], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.path);

      // Showing the panel deselects the active workspace (workspace:switched
      // null). The next open must not collapse to projects[0] (PROJECT_B).
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);
      currentPanel(s).emitDismiss();
      await flush();

      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_A.path);
    });

    it("falls back to the first project when the last active project is no longer open", async () => {
      const s = setup({ projects: [PROJECT_B, PROJECT_A], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.path);

      // PROJECT_A closed: the remembered path is no longer in the list, so the
      // reset must fall back to projects[0] rather than seeding a dead project.
      s.dispatcher.results.set(INTENT_LIST_PROJECTS, () => [PROJECT_B]);
      currentPanel(s).emitDismiss();
      await flush();

      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_B.path);
    });

    it("renders the no-project placeholder (disabled fields, disabled Create) without projects", async () => {
      const s = setup({ projects: [] });
      const panel = await s.start();

      expect(sectionById(panel.config, "project")).toBeUndefined();
      expect(field(panel.config, "project-placeholder")["disabled"]).toBe(true);
      expect(field(panel.config, "name")["disabled"]).toBe(true);
      expect(field(panel.config, "base")["disabled"]).toBe(true);
      expect(field(panel.config, "create")["disabled"]).toBe(true);
    });

    it("autofocus: folder button without a project, name field with one", async () => {
      const empty = setup({ projects: [] });
      const emptyPanel = await empty.start();
      expect(field(emptyPanel.config, "open-folder")["autofocus"]).toBe(true);
      expect(field(emptyPanel.config, "name")["autofocus"]).toBeUndefined();

      const seeded = setup();
      const seededPanel = await seeded.start();
      expect(field(seededPanel.config, "name")["autofocus"]).toBe(true);
      expect(field(seededPanel.config, "open-folder")["autofocus"]).toBeUndefined();
    });

    it("dismiss resets the session: close + reopen with fresh config", async () => {
      const s = setup();
      const panel = await s.start();

      panel.emitDismiss();
      await flush();

      expect(panel.closed).toBe(true);
      const fresh = currentPanel(s);
      expect(fresh.id).not.toBe(panel.id);
    });

    it("re-queries launch options on every form open (no stale cache)", async () => {
      const s = setup();
      await s.start();
      await flush();
      expect(s.dispatcher.byType(INTENT_GET_LAUNCH_OPTIONS)).toHaveLength(1);

      currentPanel(s).emitDismiss();
      await flush();

      expect(s.dispatcher.byType(INTENT_GET_LAUNCH_OPTIONS)).toHaveLength(2);
    });

    it("shows the agent dropdown only when more than one agent is available", async () => {
      const single = setup({ agents: [CLAUDE_AGENT] });
      const panelSingle = await single.start();
      expect(sectionById(panelSingle.config, "agent")).toBeUndefined();

      const dual = setup({ agents: [CLAUDE_AGENT, OPENCODE_AGENT] });
      const panelDual = await dual.start();
      const agent = field(panelDual.config, "agent");
      expect(suggestionValues(agent)).toEqual(["claude", "opencode"]);
      expect(agent["value"]).toBe("claude");
      expect(agent["changeEvent"]).toBe(true);
    });

    it("shows the permission-mode dropdown for Claude, populated from launch options", async () => {
      const s = setup({ agents: [CLAUDE_AGENT, OPENCODE_AGENT], defaultAgent: "claude" });
      await s.start();
      await flush();

      // Always-present free-text agent name field.
      expect(field(currentPanel(s).config, "agent-name")["type"]).toBe("input");

      // Permission mode is Claude-only: default entry plus detected modes.
      const perm = field(currentPanel(s).config, "permission-mode");
      expect(suggestionValues(perm)).toEqual(["", "plan", "acceptEdits", "bypassPermissions"]);
    });

    it("hides the permission-mode dropdown when switching to OpenCode", async () => {
      const s = setup({ agents: [CLAUDE_AGENT, OPENCODE_AGENT], defaultAgent: "claude" });
      const panel = await s.start();
      await flush();
      expect(sectionById(currentPanel(s).config, "permission-mode")).toBeDefined();

      panel.emitChange("agent", { agent: "opencode" });
      await flush();

      expect(sectionById(currentPanel(s).config, "permission-mode")).toBeUndefined();
      // The agent name field stays for both backends.
      expect(sectionById(currentPanel(s).config, "agent-name")).toBeDefined();
    });
  });

  describe("branch loading (two-phase)", () => {
    it("loads cached bases on seed and keeps loading until bases:updated confirms", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await s.start();

      // Cached list arrived; loading stays on until the refresh confirms.
      const base = field(panel.config, "base");
      expect(base["loading"]).toBe(true);
      expect(suggestionValues(base)).toEqual(["main", "origin/feature-x"]);
      expect(base["value"]).toBe("main");

      await s.emit(EVENT_BASES_UPDATED, {
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        bases: BASES_A,
        defaultBaseBranch: "main",
      });
      expect(field(panel.config, "base")["loading"]).toBe(false);
    });

    it("seeds the base field from the project's defaultBaseBranch before bases load", async () => {
      const seeded: Project = { ...PROJECT_A, defaultBaseBranch: "origin/seeded" };
      const s = setup({ projects: [seeded] });
      // Hang the bases fetch so only the synchronous first-paint seed is visible.
      s.dispatcher.results.set(INTENT_GET_PROJECT_BASES, () => new Promise(() => {}));

      const panel = await s.start();

      const base = field(panel.config, "base");
      // Value painted from the project list, not from the (pending) git round-trip.
      expect(base["value"]).toBe("origin/seeded");
      expect(base["loading"]).toBe(true);
    });

    it("leaves the base field empty when the project has no known default", async () => {
      const s = setup({ projects: [PROJECT_A] });
      s.dispatcher.results.set(INTENT_GET_PROJECT_BASES, () => new Promise(() => {}));

      const panel = await s.start();

      expect(field(panel.config, "base")["value"]).toBe("");
    });

    it("name suggestions are derivable branches (value = ref, label = derives)", async () => {
      const s = setup();
      const panel = await s.start();
      const name = field(panel.config, "name");
      const groups = name["suggestions"] as Array<{
        header?: string;
        items: Array<{ value: string; label: string }>;
      }>;
      expect(groups).toEqual([
        { header: "Local Branches", items: [{ value: "main", label: "main" }] },
        {
          header: "Remote Branches",
          items: [{ value: "origin/feature-x", label: "feature-x" }],
        },
      ]);
    });

    it("ignores bases:updated for a different project", async () => {
      const s = setup();
      const panel = await s.start();
      await s.emit(EVENT_BASES_UPDATED, {
        projectId: PROJECT_B.id,
        projectPath: PROJECT_B.path,
        bases: [],
      });
      expect(field(panel.config, "base")["loading"]).toBe(true);
    });

    it("shows 'No base branches available' when the fresh list is empty", async () => {
      const s = setup({ bases: [] });
      const panel = await s.start();
      await s.emit(EVENT_BASES_UPDATED, {
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        bases: [],
      });
      const base = field(panel.config, "base");
      expect(base["error"]).toBe("No base branches available");
      expect(field(panel.config, "create")["disabled"]).toBe(true);
    });

    it("project change reloads branches and re-defaults the base", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B], defaultBaseBranch: "main" });
      const panel = await s.start();
      await flush();

      panel.emitChange("project", { project: PROJECT_B.path });
      await flush();

      const calls = s.dispatcher.byType(INTENT_GET_PROJECT_BASES);
      expect(calls.map((c) => (c.payload as { projectPath: string }).projectPath)).toEqual([
        PROJECT_A.path,
        PROJECT_B.path,
      ]);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.path);
      expect(field(panel.config, "base")["loading"]).toBe(true);
    });
  });

  describe("validation and Create gating", () => {
    async function startValid(s: Setup): Promise<MockDialogHandle> {
      const panel = await s.start();
      await s.emit(EVENT_BASES_UPDATED, {
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        bases: BASES_A,
        defaultBaseBranch: "main",
      });
      return panel;
    }

    it("Create is disabled until a valid name is entered", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await startValid(s);
      expect(field(panel.config, "create")["disabled"]).toBe(true);

      panel.emitChange("name", { name: "new-feature" });
      await flush();
      expect(field(panel.config, "create")["disabled"]).toBe(false);
      expect(field(panel.config, "name")["error"]).toBeUndefined();
    });

    it("flags duplicate workspace names", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await startValid(s);

      panel.emitChange("name", { name: "Existing" });
      await flush();
      expect(field(panel.config, "name")["error"]).toBe("Workspace already exists");
      expect(field(panel.config, "create")["disabled"]).toBe(true);
    });

    it("flags format violations", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await startValid(s);

      panel.emitChange("name", { name: "bad name!" });
      await flush();
      expect(field(panel.config, "name")["error"]).toMatch(/letters, numbers/);
    });

    it("picking an existing branch name suggests its base", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await startValid(s);

      // A suggestion pick reports the branch ref as the field value.
      panel.emitChange("name", { name: "origin/feature-x" });
      await flush();
      expect(field(panel.config, "base")["value"]).toBe("origin/feature-x");
      // The resolved name ("feature-x") is valid.
      expect(field(panel.config, "name")["error"]).toBeUndefined();
      expect(field(panel.config, "create")["disabled"]).toBe(false);
    });
  });

  describe("submit", () => {
    async function readyPanel(s: Setup): Promise<MockDialogHandle> {
      const panel = await s.start();
      await s.emit(EVENT_BASES_UPDATED, {
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        bases: BASES_A,
        defaultBaseBranch: "main",
      });
      return panel;
    }

    it("dispatches workspace:open with source 'creation' and resets the session", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.path,
        name: "new-feature",
        base: "main",
        prompt: "",
        agent: "claude",
      });
      await flush();

      const opens = s.dispatcher.byType(INTENT_OPEN_WORKSPACE);
      expect(opens).toHaveLength(1);
      // The form always emits a typed arm for the selected backend; the
      // resolver only persists it as the workspace agent when != default.
      expect(opens[0]!.payload).toEqual({
        projectPath: PROJECT_A.path,
        workspaceName: "new-feature",
        base: "main",
        agent: { type: "claude" },
        source: "creation",
      });

      // Reset: old session closed, a fresh one opened.
      expect(panel.closed).toBe(true);
      expect(currentPanel(s).id).not.toBe(panel.id);
    });

    it("resolves a picked branch ref to its derived workspace name", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.path,
        name: "origin/feature-x",
        base: "origin/feature-x",
        prompt: "",
        agent: "claude",
      });
      await flush();

      const opens = s.dispatcher.byType(INTENT_OPEN_WORKSPACE);
      expect(opens[0]!.payload).toMatchObject({
        workspaceName: "feature-x",
        base: "origin/feature-x",
      });
    });

    it("builds a claude arm with trimmed prompt, permissionMode and agentName", async () => {
      const s = setup({
        defaultBaseBranch: "main",
        agents: [CLAUDE_AGENT, OPENCODE_AGENT],
        defaultAgent: "claude",
      });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.path,
        name: "with-prompt",
        base: "main",
        prompt: "  do things  ",
        "permission-mode": "plan",
        "agent-name": "reviewer",
        agent: "claude",
      });
      await flush();

      const opens = s.dispatcher.byType(INTENT_OPEN_WORKSPACE);
      expect(opens[0]!.payload).toMatchObject({
        agent: {
          type: "claude",
          prompt: "do things",
          permissionMode: "plan",
          agentName: "reviewer",
        },
      });
    });

    it("builds an opencode arm (agent override != default) and drops permission mode", async () => {
      const s = setup({
        defaultBaseBranch: "main",
        agents: [CLAUDE_AGENT, OPENCODE_AGENT],
        defaultAgent: "claude",
      });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.path,
        name: "with-prompt",
        base: "main",
        prompt: "do things",
        "agent-name": "build",
        agent: "opencode",
      });
      await flush();

      const opens = s.dispatcher.byType(INTENT_OPEN_WORKSPACE);
      expect(opens[0]!.payload).toMatchObject({
        agent: { type: "opencode", prompt: "do things", agentName: "build" },
      });
    });

    it("emits a bare typed arm when prompt empty, mode default, agent = default", async () => {
      const s = setup({ defaultBaseBranch: "main", defaultAgent: "claude" });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.path,
        name: "plain",
        base: "main",
        prompt: "   ",
        "permission-mode": "",
        "agent-name": "",
        agent: "claude",
      });
      await flush();

      const payload = s.dispatcher.byType(INTENT_OPEN_WORKSPACE)[0]!.payload as Record<
        string,
        unknown
      >;
      // Selected backend is emitted as a bare arm (no prompt/options); the
      // resolver won't persist it since it equals the default.
      expect(payload["agent"]).toEqual({ type: "claude" });
    });

    it("re-validates the snapshot: an invalid submit pushes errors instead of dispatching", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.path,
        name: "existing",
        base: "main",
        prompt: "",
        agent: "claude",
      });
      await flush();

      expect(s.dispatcher.byType(INTENT_OPEN_WORKSPACE)).toHaveLength(0);
      expect(panel.closed).toBe(false);
      expect(field(panel.config, "name")["error"]).toBe("Workspace already exists");
    });
  });

  describe("folder-open side-flow", () => {
    it("dispatches project:open (native picker) and selects the opened project", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();

      let resolveOpen: (value: Project | null) => void = () => {};
      s.dispatcher.results.set(
        INTENT_OPEN_PROJECT,
        () => new Promise<Project | null>((resolve) => (resolveOpen = resolve))
      );

      panel.emitAction("open-folder", {});
      await flush();

      // Picker in flight: button busy, fields disabled.
      expect(field(panel.config, "open-folder")["busy"]).toBe(true);
      expect(field(panel.config, "name")["disabled"]).toBe(true);
      expect(s.dispatcher.byType(INTENT_OPEN_PROJECT)).toHaveLength(1);
      expect(s.dispatcher.byType(INTENT_OPEN_PROJECT)[0]!.payload).toEqual({});

      resolveOpen(PROJECT_B);
      await flush();
      await flush();

      expect(field(panel.config, "open-folder")["busy"]).toBe(false);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.path);
    });

    it("handles a cancelled picker (null result)", async () => {
      const s = setup();
      const panel = await s.start();
      s.dispatcher.results.set(INTENT_OPEN_PROJECT, () => null);

      panel.emitAction("open-folder", {});
      await flush();
      await flush();

      expect(field(panel.config, "open-folder")["busy"]).toBe(false);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.path);
    });

    it("re-arms the name autofocus after a folder-open selects the project", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();
      s.dispatcher.results.set(INTENT_OPEN_PROJECT, () => PROJECT_B);

      panel.emitAction("open-folder", {});
      await flush();
      await flush();
      await flush();

      // The nudge: a push WITHOUT the name autofocus immediately followed by
      // one WITH it, so the renderer's move detection re-focuses the field.
      const flags = panel.configs.map(
        (c) => (sectionById(c, "name") as unknown as Record<string, unknown>)["autofocus"] === true
      );
      expect(flags.some((flag, i) => !flag && flags[i + 1] === true)).toBe(true);
      expect(field(panel.config, "name")["autofocus"]).toBe(true);
    });

    it("shows a form error when the open fails", async () => {
      const s = setup();
      const panel = await s.start();
      s.dispatcher.results.set(INTENT_OPEN_PROJECT, () =>
        Promise.reject(new Error("not a git repository"))
      );

      panel.emitAction("open-folder", {});
      await flush();
      await flush();

      const errorSection = panel.config.sections.find(
        (sec) => sec.type === "text" && sec.icon === "error"
      );
      expect(errorSection).toMatchObject({ content: "not a git repository" });
    });
  });

  describe("git-clone sub-dialog", () => {
    it("opens a modal dialog with URL validation gating the Clone button", async () => {
      const s = setup();
      const panel = await s.start();

      panel.emitAction("clone", {});
      await flush();

      const clone = s.dialogs.modalHandles()[0]!;
      expect(clone.kind).toBe("modal");
      expect(field(clone.config, "do-clone")["disabled"]).toBe(true);

      clone.emitChange("url", { url: "not a url" });
      await flush();
      expect(field(clone.config, "url")["error"]).toMatch(/git URL/);
      expect(field(clone.config, "do-clone")["disabled"]).toBe(true);

      clone.emitChange("url", { url: "org/repo" });
      await flush();
      expect(field(clone.config, "url")["error"]).toBeUndefined();
      expect(field(clone.config, "do-clone")["disabled"]).toBe(false);
    });

    it("clones via project:open {git} and selects the project on success", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();

      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;

      let resolveClone: (value: Project) => void = () => {};
      s.dispatcher.results.set(
        INTENT_OPEN_PROJECT,
        () => new Promise<Project>((resolve) => (resolveClone = resolve))
      );

      clone.emitChange("url", { url: "org/repo" });
      await flush();
      clone.emitAction("do-clone", { url: "org/repo" });
      await flush();

      // Cloning: URL locked, footer switches to Continue in background.
      expect(field(clone.config, "url")["disabled"]).toBe(true);
      expect(sectionById(clone.config, "background")).toBeDefined();
      expect(sectionById(clone.config, "cancel")).toBeUndefined();
      expect(s.dispatcher.byType(INTENT_OPEN_PROJECT)[0]!.payload).toEqual({ git: "org/repo" });

      resolveClone(PROJECT_B);
      await flush();
      await flush();

      expect(clone.closed).toBe(true);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.path);
    });

    it("shows the GitHub create-on-error flow for a GitHub-shaped URL", async () => {
      const s = setup();
      const panel = await s.start();

      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;
      s.dispatcher.results.set(INTENT_OPEN_PROJECT, () =>
        Promise.reject(new Error("repository not found"))
      );

      clone.emitChange("url", { url: "org/repo" });
      await flush();
      clone.emitAction("do-clone", { url: "org/repo" });
      await flush();
      await flush();

      expect(sectionById(clone.config, "github-create")).toBeDefined();
      expect(sectionById(clone.config, "retry")).toBeDefined();

      clone.emitAction("github-create", { url: "org/repo" });
      await flush();
      expect(s.openUrl).toHaveBeenCalledWith("https://github.com/new?owner=org&name=repo");
    });

    it("shows a plain error (no GitHub flow) for non-GitHub URLs", async () => {
      const s = setup();
      const panel = await s.start();

      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;
      s.dispatcher.results.set(INTENT_OPEN_PROJECT, () =>
        Promise.reject(new Error("connection refused"))
      );

      clone.emitChange("url", { url: "https://gitlab.example.com/org/repo.git" });
      await flush();
      clone.emitAction("do-clone", { url: "https://gitlab.example.com/org/repo.git" });
      await flush();
      await flush();

      expect(sectionById(clone.config, "github-create")).toBeUndefined();
      const errorSection = clone.config.sections.find(
        (sec) => sec.type === "text" && sec.icon === "error"
      );
      expect(errorSection).toMatchObject({ content: "connection refused" });
    });

    it("shows inline clone progress from clone:progress events", async () => {
      const s = setup();
      const panel = await s.start();

      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;
      s.dispatcher.results.set(INTENT_OPEN_PROJECT, () => new Promise<Project>(() => {}));

      clone.emitChange("url", { url: "org/repo" });
      await flush();
      clone.emitAction("do-clone", { url: "org/repo" });
      await flush();

      // Cloning with no progress yet: indeterminate running item.
      const progressSection = (): Record<string, unknown> | undefined =>
        clone.config.sections.find((sec) => sec.type === "progress") as unknown as
          | Record<string, unknown>
          | undefined;
      expect(progressSection()).toBeDefined();
      expect((progressSection()!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({
        status: "running",
      });

      // The event carries 0-1; the progress item is scaled to 0-100.
      await s.emit(EVENT_CLONE_PROGRESS, {
        stage: "Receiving objects",
        progress: 0.42,
        name: "repo",
        url: "org/repo",
      });
      expect((progressSection()!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({
        progress: 42,
        message: "Receiving objects",
      });

      // Progress for a different URL is ignored.
      await s.emit(EVENT_CLONE_PROGRESS, {
        stage: "other",
        progress: 0.99,
        name: "other",
        url: "other/repo",
      });
      expect((progressSection()!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({
        progress: 42,
      });
    });

    it("'Continue in background' closes the dialog; the clone result lands silently", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();
      const seededProject = field(panel.config, "project")["value"];

      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;

      let resolveClone: (value: Project) => void = () => {};
      s.dispatcher.results.set(
        INTENT_OPEN_PROJECT,
        () => new Promise<Project>((resolve) => (resolveClone = resolve))
      );
      clone.emitChange("url", { url: "org/repo" });
      await flush();
      clone.emitAction("do-clone", { url: "org/repo" });
      await flush();

      clone.emitAction("background", {});
      await flush();
      expect(clone.closed).toBe(true);

      // The detached clone completing must NOT hijack the form selection.
      resolveClone(PROJECT_B);
      await flush();
      await flush();
      expect(field(panel.config, "project")["value"]).toBe(seededProject);
    });

    it("Cancel closes the dialog when not cloning", async () => {
      const s = setup();
      const panel = await s.start();
      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;

      clone.emitAction("cancel", {});
      await flush();
      expect(clone.closed).toBe(true);
    });

    it("Cancel carries role 'cancel' when not cloning, so Escape clicks it", async () => {
      const s = setup();
      const panel = await s.start();
      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;

      // The cancel-role marker is what makes the form route Escape to Cancel.
      expect(cancelButton(clone.config)?.id).toBe("cancel");

      clone.emitAction("cancel", {});
      await flush();
      expect(clone.closed).toBe(true);
    });

    it("Cancel carries role 'cancel' after a failed clone", async () => {
      const s = setup();
      const panel = await s.start();
      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;
      s.dispatcher.results.set(INTENT_OPEN_PROJECT, () => Promise.reject(new Error("nope")));

      clone.emitChange("url", { url: "org/repo" });
      await flush();
      clone.emitAction("do-clone", { url: "org/repo" });
      await flush();
      await flush();

      expect(cancelButton(clone.config)?.id).toBe("cancel");

      clone.emitAction("cancel", {});
      await flush();
      expect(clone.closed).toBe(true);
    });

    it("mid-clone, 'Continue in background' is the cancel-role button (Escape detaches)", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();
      const seededProject = field(panel.config, "project")["value"];

      panel.emitAction("clone", {});
      await flush();
      const clone = s.dialogs.modalHandles()[0]!;

      let resolveClone: (value: Project) => void = () => {};
      s.dispatcher.results.set(
        INTENT_OPEN_PROJECT,
        () => new Promise<Project>((resolve) => (resolveClone = resolve))
      );
      clone.emitChange("url", { url: "org/repo" });
      await flush();
      clone.emitAction("do-clone", { url: "org/repo" });
      await flush();

      // Mid-clone, Escape maps to the only footer button — "Continue in background".
      expect(cancelButton(clone.config)?.id).toBe("background");

      clone.emitAction("background", {});
      await flush();
      expect(clone.closed).toBe(true);

      // The detached clone completing must NOT hijack the form selection.
      resolveClone(PROJECT_B);
      await flush();
      await flush();
      expect(field(panel.config, "project")["value"]).toBe(seededProject);
    });
  });

  describe("seeding from domain events", () => {
    it("a freshly opened project seeds the NEXT reset, not the live form", async () => {
      const s = setup({ projects: [PROJECT_A] });
      const panel = await s.start();

      await s.emit(EVENT_PROJECT_OPENED, { project: PROJECT_B });
      // Live selection unchanged; the new project joined the suggestions.
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.path);

      panel.emitDismiss();
      await flush();
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_A.path);
    });

    it("seeds the next reset with the freshly opened project when it is still open", async () => {
      const projects: Project[] = [PROJECT_A];
      const s = setup({ projects });
      const panel = await s.start();

      projects.push(PROJECT_B);
      await s.emit(EVENT_PROJECT_OPENED, { project: PROJECT_B });

      panel.emitDismiss();
      await flush();
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_B.path);
    });

    it("workspace:switched clears the pending opened-project seed", async () => {
      const projects: Project[] = [PROJECT_A];
      const s = setup({ projects, activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();

      projects.push(PROJECT_B);
      await s.emit(EVENT_PROJECT_OPENED, { project: PROJECT_B });
      await s.emit(EVENT_WORKSPACE_SWITCHED, switchedPayload(PROJECT_A));

      panel.emitDismiss();
      await flush();
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_A.path);
    });

    it("falls back when the selected project is closed", async () => {
      const projects: Project[] = [PROJECT_A, PROJECT_B];
      const s = setup({ projects, activeWorkspaceProjectId: null });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.path);

      projects.splice(0, 1); // PROJECT_A closed
      await s.emit(EVENT_PROJECT_CLOSED, { projectId: PROJECT_A.id, projectPath: PROJECT_A.path });

      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.path);
    });

    it("clears to the placeholder when the last project is closed", async () => {
      const projects: Project[] = [PROJECT_A];
      const s = setup({ projects, activeWorkspaceProjectId: null });
      const panel = await s.start();

      projects.splice(0, 1);
      await s.emit(EVENT_PROJECT_CLOSED, { projectId: PROJECT_A.id, projectPath: PROJECT_A.path });

      expect(sectionById(panel.config, "project")).toBeUndefined();
      expect(field(panel.config, "project-placeholder")["disabled"]).toBe(true);
    });
  });
});

describe("validateCloneUrl", () => {
  it.each([
    "https://github.com/org/repo.git",
    "http://example.com/repo",
    "git@github.com:org/repo.git",
    "git://example.com/repo.git",
    "ssh://git@example.com/repo.git",
    "org/repo",
    "github.com/org/repo",
    "",
    "   ",
  ])("accepts %j", (url) => {
    expect(validateCloneUrl(url)).toBeNull();
  });

  it.each(["not a url", "just-words", "/absolute/path"])("rejects %j", (url) => {
    expect(validateCloneUrl(url)).not.toBeNull();
  });
});
