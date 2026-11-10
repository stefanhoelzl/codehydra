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
import { createCreationModule } from "./creation-module";
import type { CreationModule, CreationModuleDeps } from "./creation-module";
import { createMockDialogManager } from "./presentation/dialog-manager.state-mock";
import type { MockDialogHandle } from "./presentation/dialog-manager.state-mock";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogConfig, DialogSection } from "../shared/dialog-types";
import type { ConfigAgentType } from "../boundaries/platform/config";
import type { Project, ProjectId, WorkspaceName } from "../shared/api/types";
import type { BaseInfo } from "../boundaries/platform/git-types";
import type { AgentInfo } from "../shared/ipc";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import { EVENT_PROJECT_OPENED } from "../intents/open-project";
import { EVENT_PROJECT_CLOSED } from "../intents/close-project";
import {
  EVENT_OPTION_CHOICES_UPDATED,
  INTENT_GET_OPTION_CHOICES,
  type GetOptionChoicesResult,
} from "../intents/get-option-choices";
import { INTENT_ADD_PROJECT, INTENT_LIST_ADD_ACTIONS } from "../intents/add-project";
import { testProjectTypes } from "../intents/project-type-options.test-utils";
import { branchChoices } from "./git/choices";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import { INTENT_OPEN_WORKSPACE } from "../intents/open-workspace";
import { INTENT_LIST_PROJECTS } from "../intents/list-projects";
import { INTENT_GET_LAUNCH_OPTIONS } from "../intents/agent-launch-options";
import { wsPath, projPath, workspaceRefIn } from "../shared/test-fixtures";
import { makeWorkspaceRef } from "../utils/ref";
import { gitProjectRef } from "./git/ref";
import { fakeProjectRef } from "./fake-project-type.test-utils";

// =============================================================================
// Fixtures
// =============================================================================

const PROJECT_A: Project = {
  ref: gitProjectRef(projPath("/projects/a")),
  id: "project-a-12345678" as ProjectId,
  name: "project-a",
  path: projPath("/projects/a"),
  workspaces: [
    {
      ref: workspaceRefIn(projPath("/projects/a"), "existing"),
      projectId: "project-a-12345678" as ProjectId,
      name: "existing" as WorkspaceName,
      subtitle: "existing",
      metadata: {},
      path: wsPath("/projects/a/.worktrees/existing"),
    },
  ],
};

const PROJECT_B: Project = {
  ref: gitProjectRef(projPath("/projects/b")),
  id: "project-b-12345678" as ProjectId,
  name: "project-b",
  path: projPath("/projects/b"),
  workspaces: [],
};

const BASES_A: readonly BaseInfo[] = [
  { name: "main", isRemote: false, derives: "main" },
  { name: "origin/feature-x", isRemote: true, base: "origin/feature-x", derives: "feature-x" },
];

/** A git project's choices answer for these branches, as the git module gives it. */
function choicesOf(
  project: Project,
  bases: readonly BaseInfo[],
  defaultBase?: string
): GetOptionChoicesResult {
  const answer = branchChoices(bases, defaultBase);
  return {
    fields: answer.fields ?? {},
    nameSuggestions: answer.nameSuggestions ?? [],
    projectRef: project.ref,
    projectId: project.id,
  };
}

/** The option-choices:updated payload for a project's fresh branches. */
const updated = choicesOf;

/** The add-project buttons the folder picker (view-module) and git contribute. */
const ADD_ACTIONS = [
  { id: "open-folder", icon: "folder-opened", title: "Open project folder" },
  { id: "git-clone", icon: "source-control", title: "Clone from Git" },
];

const CLAUDE_AGENT: AgentInfo = { agent: "claude", label: "Claude Code", icon: "claude" };
const OPENCODE_AGENT: AgentInfo = { agent: "opencode", label: "OpenCode", icon: "opencode" };

/** A non-null workspace:switched payload for a project (active-surface bookkeeping). */
function switchedPayload(project: Project): Record<string, unknown> {
  return {
    projectId: project.id,
    projectName: project.name,
    projectRef: project.ref,
    workspaceName: "active" as WorkspaceName,
    workspaceRef: makeWorkspaceRef(project.ref, "active"),
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
  module: CreationModule;
  dialogs: ReturnType<typeof createMockDialogManager>;
  dispatcher: MockDispatcher;
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

  const projects = options?.projects ?? [PROJECT_A];
  dispatcher.results.set(INTENT_LIST_PROJECTS, () => projects);
  dispatcher.results.set(INTENT_LIST_ADD_ACTIONS, () => ADD_ACTIONS);
  dispatcher.results.set(INTENT_GET_OPTION_CHOICES, (payload) => {
    const p = payload as { projectRef: string };
    const project = projects.find((candidate) => candidate.ref === p.projectRef) ?? PROJECT_A;
    return choicesOf(project, options?.bases ?? BASES_A, options?.defaultBaseBranch);
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
    projectTypes: testProjectTypes(),
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

  return { module, dialogs, dispatcher, emit, start };
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
      expect(project["value"]).toBe(PROJECT_A.ref);
      expect(suggestionValues(project)).toEqual([PROJECT_B.ref, PROJECT_A.ref]);
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
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
    });

    it("keeps seeding the last active project across the panel-open deselect", async () => {
      // PROJECT_A is active but is NOT projects[0] — proves the seed follows the
      // active workspace, not the list head.
      const s = setup({ projects: [PROJECT_B, PROJECT_A], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);

      // Showing the panel deselects the active workspace (workspace:switched
      // null). The next open must not collapse to projects[0] (PROJECT_B).
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);
      currentPanel(s).emitDismiss();
      await flush();

      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_A.ref);
    });

    it("re-seeds an untouched form with the project of the workspace the panel was opened from", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);

      // Work in a PROJECT_B workspace, then show the panel (the deselect).
      await s.emit(EVENT_WORKSPACE_SWITCHED, switchedPayload(PROJECT_B));
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);

      // Same session (nothing reset it), now on PROJECT_B with its bases fetched.
      expect(currentPanel(s)).toBe(panel);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
      const fetched = s.dispatcher.byType(INTENT_GET_OPTION_CHOICES).at(-1);
      expect((fetched?.payload as { projectRef: string }).projectRef).toBe(PROJECT_B.ref);
    });

    it("keeps a touched form's project when the panel is opened from another project", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();
      panel.emitChange("name", { name: "half-typed" });
      await flush();

      await s.emit(EVENT_WORKSPACE_SWITCHED, switchedPayload(PROJECT_B));
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);

      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);
      expect(field(panel.config, "name")["initialValue"]).toBe("half-typed");
    });

    it("a project preset (a sidebar project's +) wins over the workspace the panel came from", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();
      panel.emitChange("name", { name: "half-typed" });
      await flush();

      // The + of PROJECT_B, clicked while a PROJECT_A workspace is active.
      s.module.presetProject(PROJECT_B.ref, true);
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);

      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
      expect(field(panel.config, "name")["initialValue"]).toBe("half-typed");

      // A touched form keeps the preset project when the panel is opened again.
      await s.emit(EVENT_WORKSPACE_SWITCHED, switchedPayload(PROJECT_A));
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
    });

    it("a preset with the panel already showing applies at once and is not kept", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();

      s.module.presetProject(PROJECT_B.ref, false);
      await flush();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);

      await s.emit(EVENT_WORKSPACE_SWITCHED, switchedPayload(PROJECT_A));
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);
    });

    it("does not re-fetch bases when the panel is opened from the same project", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B], activeWorkspaceProjectId: PROJECT_A.id });
      await s.start();
      const before = s.dispatcher.byType(INTENT_GET_OPTION_CHOICES).length;

      await s.emit(EVENT_WORKSPACE_SWITCHED, switchedPayload(PROJECT_A));
      await s.emit(EVENT_WORKSPACE_SWITCHED, null);

      expect(s.dispatcher.byType(INTENT_GET_OPTION_CHOICES)).toHaveLength(before);
    });

    it("falls back to the first project when the last active project is no longer open", async () => {
      const s = setup({ projects: [PROJECT_B, PROJECT_A], activeWorkspaceProjectId: PROJECT_A.id });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);

      // PROJECT_A closed: the remembered path is no longer in the list, so the
      // reset must fall back to projects[0] rather than seeding a dead project.
      s.dispatcher.results.set(INTENT_LIST_PROJECTS, () => [PROJECT_B]);
      currentPanel(s).emitDismiss();
      await flush();

      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_B.ref);
    });

    it("renders the no-project placeholder (disabled fields, disabled Create) without projects", async () => {
      const s = setup({ projects: [] });
      const panel = await s.start();

      expect(sectionById(panel.config, "project")).toBeUndefined();
      expect(field(panel.config, "project-placeholder")["disabled"]).toBe(true);
      expect(field(panel.config, "name")["disabled"]).toBe(true);
      // No project, so no project type whose options could be shown.
      expect(sectionById(panel.config, "base")).toBeUndefined();
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

  describe("option choices (two-phase)", () => {
    it("loads the type's first answer on seed and keeps loading until option-choices:updated confirms", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await s.start();

      // Cached list arrived; loading stays on until the refresh confirms.
      const base = field(panel.config, "base");
      expect(base["loading"]).toBe(true);
      expect(suggestionValues(base)).toEqual(["main", "origin/feature-x"]);
      expect(base["value"]).toBe("main");

      await s.emit(EVENT_OPTION_CHOICES_UPDATED, updated(PROJECT_A, BASES_A, "main"));
      expect(field(panel.config, "base")["loading"]).toBe(false);
    });

    it("renders the selected project's type's options after Name, from its description", async () => {
      const s = setup();
      const panel = await s.start();

      // git's: base (a dynamic select); tracking is not a dialog field.
      const ids = panel.config.sections.flatMap((section) => ("id" in section ? [section.id] : []));
      expect(ids.slice(0, 3)).toEqual(["name", "base", "prompt"]);
      expect(sectionById(panel.config, "tracking")).toBeUndefined();
      expect(field(panel.config, "base")).toMatchObject({
        type: "dropdown",
        label: "Base Branch",
        placeholder: "Select branch...",
      });
    });

    it("renders another type's own options instead, and submits them", async () => {
      const fake: Project = {
        ...PROJECT_B,
        ref: fakeProjectRef(projPath("/projects/f")),
        name: "folders",
      };
      const s = setup({ projects: [fake] });
      s.dispatcher.results.set(INTENT_GET_OPTION_CHOICES, () => ({
        fields: {},
        nameSuggestions: [],
        projectRef: fake.ref,
        projectId: fake.id,
      }));
      const panel = await s.start();

      expect(sectionById(panel.config, "base")).toBeUndefined();
      const template = field(panel.config, "template");
      expect(template).toMatchObject({ type: "dropdown", label: "Template", value: "empty" });
      expect(suggestionValues(template)).toEqual(["empty", "readme"]);

      panel.emitChange("template", { template: "readme" });
      panel.emitChange("name", { name: "notes" });
      await flush();
      panel.emitAction("create", { project: fake.ref, name: "notes", template: "readme" });
      await flush();

      expect(s.dispatcher.byType(INTENT_OPEN_WORKSPACE)[0]!.payload).toMatchObject({
        projectRef: fake.ref,
        workspaceName: "notes",
        options: { template: "readme" },
      });
    });

    it("does not read the project list's defaultBaseBranch", async () => {
      const seeded: Project = { ...PROJECT_A, defaultBaseBranch: "origin/seeded" };
      const s = setup({ projects: [seeded] });
      s.dispatcher.results.set(INTENT_GET_OPTION_CHOICES, () => new Promise(() => {}));

      const panel = await s.start();

      // The default comes from the type's choices answer, which is pending.
      const base = field(panel.config, "base");
      expect(base["value"]).toBe("");
      expect(base["loading"]).toBe(true);
    });

    it("leaves the base field empty when the project has no known default", async () => {
      const s = setup({ projects: [PROJECT_A] });
      s.dispatcher.results.set(INTENT_GET_OPTION_CHOICES, () => new Promise(() => {}));

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
      await s.emit(EVENT_OPTION_CHOICES_UPDATED, updated(PROJECT_B, []));
      expect(field(panel.config, "base")["loading"]).toBe(true);
    });

    it("shows 'No base branches available' when the fresh list is empty", async () => {
      const s = setup({ bases: [] });
      const panel = await s.start();
      await s.emit(EVENT_OPTION_CHOICES_UPDATED, updated(PROJECT_A, []));
      const base = field(panel.config, "base");
      expect(base["error"]).toBe("No base branches available");
      expect(field(panel.config, "create")["disabled"]).toBe(true);
    });

    it("project change reloads branches and re-defaults the base", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B], defaultBaseBranch: "main" });
      const panel = await s.start();
      await flush();

      panel.emitChange("project", { project: PROJECT_B.ref });
      await flush();

      const calls = s.dispatcher.byType(INTENT_GET_OPTION_CHOICES);
      expect(calls.map((c) => (c.payload as { projectRef: string }).projectRef)).toEqual([
        PROJECT_A.ref,
        PROJECT_B.ref,
      ]);
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
      expect(field(panel.config, "base")["loading"]).toBe(true);
    });
  });

  describe("validation and Create gating", () => {
    async function startValid(s: Setup): Promise<MockDialogHandle> {
      const panel = await s.start();
      await s.emit(EVENT_OPTION_CHOICES_UPDATED, updated(PROJECT_A, BASES_A, "main"));
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
      await s.emit(EVENT_OPTION_CHOICES_UPDATED, updated(PROJECT_A, BASES_A, "main"));
      return panel;
    }

    it("dispatches workspace:open with source 'creation' and resets the session", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await readyPanel(s);

      // Single available agent: the agent dropdown isn't rendered, so the
      // renderer's snapshot carries no "agent" key (see the single-backend
      // regression test below).
      panel.emitAction("create", {
        project: PROJECT_A.ref,
        name: "new-feature",
        base: "main",
        prompt: "",
      });
      await flush();

      const opens = s.dispatcher.byType(INTENT_OPEN_WORKSPACE);
      expect(opens).toHaveLength(1);
      // The form always emits a typed arm for the selected backend; the
      // resolver only persists it as the workspace agent when != default.
      expect(opens[0]!.payload).toEqual({
        projectRef: PROJECT_A.ref,
        workspaceName: "new-feature",
        options: { base: "main" },
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
        project: PROJECT_A.ref,
        name: "origin/feature-x",
        base: "origin/feature-x",
        prompt: "",
      });
      await flush();

      const opens = s.dispatcher.byType(INTENT_OPEN_WORKSPACE);
      expect(opens[0]!.payload).toMatchObject({
        workspaceName: "feature-x",
        options: { base: "origin/feature-x" },
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
        project: PROJECT_A.ref,
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
        project: PROJECT_A.ref,
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
        project: PROJECT_A.ref,
        name: "plain",
        base: "main",
        prompt: "   ",
        "permission-mode": "",
        "agent-name": "",
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

    // Regression: with a single available backend the agent dropdown is not
    // rendered, so the snapshot has no "agent" key. Keying the arm off that
    // field degraded the spec to the option-less "default" arm and silently
    // dropped permissionMode/agentName — the prompt then ran under Claude's
    // own default mode instead of the selected one.
    it("keeps permissionMode and agentName when the agent field is absent (single backend)", async () => {
      const s = setup({ defaultBaseBranch: "main", defaultAgent: "claude" });
      const panel = await readyPanel(s);

      // The dropdown is genuinely absent from the rendered form.
      expect(sectionById(currentPanel(s).config, "agent")).toBeUndefined();

      panel.emitAction("create", {
        project: PROJECT_A.ref,
        name: "planned",
        base: "main",
        prompt: "do things",
        "permission-mode": "plan",
        "agent-name": "reviewer",
      });
      await flush();

      expect(s.dispatcher.byType(INTENT_OPEN_WORKSPACE)[0]!.payload).toMatchObject({
        agent: {
          type: "claude",
          prompt: "do things",
          permissionMode: "plan",
          agentName: "reviewer",
        },
      });
    });

    it("emits a typed arm for a mode-only create (no prompt, agent field absent)", async () => {
      const s = setup({ defaultBaseBranch: "main", defaultAgent: "claude" });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.ref,
        name: "mode-only",
        base: "main",
        prompt: "",
        "permission-mode": "plan",
      });
      await flush();

      expect(s.dispatcher.byType(INTENT_OPEN_WORKSPACE)[0]!.payload).toMatchObject({
        agent: { type: "claude", permissionMode: "plan" },
      });
    });

    it("re-validates the snapshot: an invalid submit pushes errors instead of dispatching", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await readyPanel(s);

      panel.emitAction("create", {
        project: PROJECT_A.ref,
        name: "existing",
        base: "main",
        prompt: "",
      });
      await flush();

      expect(s.dispatcher.byType(INTENT_OPEN_WORKSPACE)).toHaveLength(0);
      expect(panel.closed).toBe(false);
      expect(field(panel.config, "name")["error"]).toBe("Workspace already exists");
    });
  });

  describe("add-project buttons", () => {
    it("runs a contributed button's flow (project:add) and selects the project it opened", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();

      let resolveOpen: (value: Project | null) => void = () => {};
      s.dispatcher.results.set(
        INTENT_ADD_PROJECT,
        () => new Promise<Project | null>((resolve) => (resolveOpen = resolve))
      );

      panel.emitAction("open-folder", {});
      await flush();

      // Flow in flight: its button busy, the other button and the fields waiting.
      expect(field(panel.config, "open-folder")["busy"]).toBe(true);
      expect(field(panel.config, "git-clone")["disabled"]).toBe(true);
      expect(field(panel.config, "name")["disabled"]).toBe(true);
      expect(s.dispatcher.byType(INTENT_ADD_PROJECT)).toHaveLength(1);
      expect(s.dispatcher.byType(INTENT_ADD_PROJECT)[0]!.payload).toEqual({
        action: "open-folder",
      });

      resolveOpen(PROJECT_B);
      await flush();
      await flush();

      expect(field(panel.config, "open-folder")["busy"]).toBeUndefined();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
    });

    it("handles a cancelled picker (null result)", async () => {
      const s = setup();
      const panel = await s.start();
      s.dispatcher.results.set(INTENT_ADD_PROJECT, () => null);

      panel.emitAction("open-folder", {});
      await flush();
      await flush();

      expect(field(panel.config, "open-folder")["busy"]).toBeUndefined();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);
    });

    it("re-arms the name autofocus after an add-project flow selects the project", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();
      s.dispatcher.results.set(INTENT_ADD_PROJECT, () => PROJECT_B);

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
      s.dispatcher.results.set(INTENT_ADD_PROJECT, () =>
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

    it("renders the contributed buttons, in the order they were listed, before the dropdown", async () => {
      const s = setup();
      const panel = await s.start();

      const row = panel.config.sections.find(
        (section) => section.type === "group" && section.label === "Project"
      ) as { items: readonly { type: string; id: string; icon?: string; title?: string }[] };
      expect(row.items.map((item) => item.id)).toEqual(["open-folder", "git-clone", "project"]);
      expect(row.items[1]).toMatchObject({ icon: "source-control", title: "Clone from Git" });
    });

    it("renders only the buttons modules contribute (a type need not have one)", async () => {
      const s = setup({ projects: [] });
      s.dispatcher.results.set(INTENT_LIST_ADD_ACTIONS, () => [ADD_ACTIONS[0]!]);
      const panel = await s.start();

      expect(sectionById(panel.config, "open-folder")).toBeDefined();
      expect(sectionById(panel.config, "git-clone")).toBeUndefined();
      expect(field(panel.config, "project-placeholder")["placeholder"]).toBe(
        "Open or add a project"
      );
    });

    it("runs the clone button through project:add like any other", async () => {
      const s = setup({ projects: [PROJECT_A, PROJECT_B] });
      const panel = await s.start();
      s.dispatcher.results.set(INTENT_ADD_PROJECT, () => PROJECT_B);

      panel.emitAction("git-clone", {});
      await flush();
      await flush();

      expect(s.dispatcher.byType(INTENT_ADD_PROJECT)[0]!.payload).toEqual({ action: "git-clone" });
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
    });
  });

  describe("seeding from domain events", () => {
    it("a freshly opened project seeds the NEXT reset, not the live form", async () => {
      const s = setup({ projects: [PROJECT_A] });
      const panel = await s.start();

      await s.emit(EVENT_PROJECT_OPENED, { project: PROJECT_B });
      // Live selection unchanged; the new project joined the suggestions.
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);

      panel.emitDismiss();
      await flush();
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_A.ref);
    });

    it("seeds the next reset with the freshly opened project when it is still open", async () => {
      const projects: Project[] = [PROJECT_A];
      const s = setup({ projects });
      const panel = await s.start();

      projects.push(PROJECT_B);
      await s.emit(EVENT_PROJECT_OPENED, { project: PROJECT_B });

      panel.emitDismiss();
      await flush();
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_B.ref);
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
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_A.ref);
    });

    it("falls back when the selected project is closed", async () => {
      const projects: Project[] = [PROJECT_A, PROJECT_B];
      const s = setup({ projects, activeWorkspaceProjectId: null });
      const panel = await s.start();
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);

      projects.splice(0, 1); // PROJECT_A closed
      await s.emit(EVENT_PROJECT_CLOSED, { projectId: PROJECT_A.id, projectRef: PROJECT_A.ref });

      expect(field(panel.config, "project")["value"]).toBe(PROJECT_B.ref);
    });

    it("clears to the placeholder when the last project is closed", async () => {
      const projects: Project[] = [PROJECT_A];
      const s = setup({ projects, activeWorkspaceProjectId: null });
      const panel = await s.start();

      projects.splice(0, 1);
      await s.emit(EVENT_PROJECT_CLOSED, { projectId: PROJECT_A.id, projectRef: PROJECT_A.ref });

      expect(sectionById(panel.config, "project")).toBeUndefined();
      expect(field(panel.config, "project-placeholder")["disabled"]).toBe(true);
    });
  });

  describe("remembering inputs across a close/reopen", () => {
    /** A panel with branches loaded and every field filled in. */
    async function filledPanel(s: Setup): Promise<MockDialogHandle> {
      const panel = await s.start();
      await s.emit(EVENT_OPTION_CHOICES_UPDATED, updated(PROJECT_A, BASES_A, "main"));
      panel.emitChange("name", { name: "remembered" });
      panel.emitChange("prompt", { prompt: "do the thing" });
      panel.emitChange("agent-name", { "agent-name": "reviewer" });
      await flush();
      return panel;
    }

    it("pushes every field back as a controlled value so a remount restores it", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await filledPanel(s);

      // The renderer unmounts the panel on hide, so the module is the only
      // thing that survives: each field must carry its value in the config.
      // Free-text fields seed (initialValue) rather than push (value), so
      // echoing the user's own text back cannot race their typing.
      expect(field(panel.config, "name")["initialValue"]).toBe("remembered");
      // Restored text arrives selected so the first keystroke replaces it.
      expect(field(panel.config, "name")["selectInitialValue"]).toBe(true);
      expect(field(panel.config, "prompt")["initialValue"]).toBe("do the thing");
      expect(field(panel.config, "agent-name")["initialValue"]).toBe("reviewer");
      expect(field(panel.config, "base")["value"]).toBe("main");
      expect(field(panel.config, "project")["value"]).toBe(PROJECT_A.ref);
    });

    it("keeps the session open (no reset) when nothing asks for one", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await filledPanel(s);

      // Nothing dismissed the form, so it is still the same session — the
      // values above are still there to be restored on the next show.
      expect(panel.closed).toBe(false);
      expect(currentPanel(s)).toBe(panel);
    });

    it("is edited from the first input until a reset", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      // Seeding the project is not input.
      const panel = await s.start();
      expect(s.module.isEdited()).toBe(false);

      panel.emitChange("name", { name: "half-typed" });
      await flush();
      expect(s.module.isEdited()).toBe(true);

      panel.emitAction("reset", {});
      await flush();
      expect(s.module.isEdited()).toBe(false);
    });

    it("clears every field on reset", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await filledPanel(s);

      panel.emitAction("reset", {});
      await flush();

      expect(panel.closed).toBe(true);
      const fresh = currentPanel(s);
      expect(field(fresh.config, "name")["initialValue"]).toBe("");
      expect(field(fresh.config, "prompt")["initialValue"]).toBe("");
      expect(field(fresh.config, "agent-name")["initialValue"]).toBe("");
    });

    it("re-seeds the project on reset", async () => {
      const s = setup({
        projects: [PROJECT_B, PROJECT_A],
        activeWorkspaceProjectId: PROJECT_A.id,
        defaultBaseBranch: "main",
      });
      const panel = await s.start();

      panel.emitChange("project", { project: PROJECT_B.ref });
      await flush();
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_B.ref);

      currentPanel(s).emitAction("reset", {});
      await flush();

      // Reset is the only thing that re-seeds; a plain reopen would have kept
      // the manual pick.
      expect(field(currentPanel(s).config, "project")["value"]).toBe(PROJECT_A.ref);
    });

    it("clears the remembered fields after a successful create", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await filledPanel(s);

      panel.emitAction("create", {
        name: "remembered",
        base: "main",
        prompt: "do the thing",
        "agent-name": "reviewer",
      });
      await flush();

      const fresh = currentPanel(s);
      expect(field(fresh.config, "name")["initialValue"]).toBe("");
      expect(field(fresh.config, "prompt")["initialValue"]).toBe("");
    });
  });

  describe("Reset button", () => {
    it("is disabled on a fresh form and enabled once any input is made", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await s.start();
      expect(field(panel.config, "reset")["disabled"]).toBe(true);

      panel.emitChange("prompt", { prompt: "x" });
      await flush();

      // "as soon as any input was made" — the prompt alone is enough, even
      // though it takes no part in Create gating.
      expect(field(currentPanel(s).config, "reset")["disabled"]).toBe(false);
      expect(field(currentPanel(s).config, "create")["disabled"]).toBe(true);
    });

    it("is disabled again after a reset", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await s.start();
      panel.emitChange("prompt", { prompt: "x" });
      await flush();

      currentPanel(s).emitAction("reset", {});
      await flush();

      expect(field(currentPanel(s).config, "reset")["disabled"]).toBe(true);
    });

    it("carries role 'cancel' so Escape and the button are the same gesture", async () => {
      const s = setup({ defaultBaseBranch: "main" });
      const panel = await s.start();
      panel.emitChange("prompt", { prompt: "x" });
      await flush();

      expect(cancelButton(currentPanel(s).config)?.id).toBe("reset");
    });

    it("seeding the form does not count as input", async () => {
      const s = setup({
        projects: [PROJECT_B, PROJECT_A],
        activeWorkspaceProjectId: PROJECT_A.id,
        defaultBaseBranch: "main",
      });
      await s.start();
      await s.emit(EVENT_OPTION_CHOICES_UPDATED, updated(PROJECT_A, BASES_A, "main"));

      // openSession() seeded the project and the base branch without the user
      // touching anything, so the form is still clean.
      expect(field(currentPanel(s).config, "base")["value"]).toBe("main");
      expect(field(currentPanel(s).config, "reset")["disabled"]).toBe(true);
    });
  });

  describe("permission mode", () => {
    it("collapses a remembered mode the current backend does not offer", async () => {
      const s = setup({
        agents: [CLAUDE_AGENT, OPENCODE_AGENT],
      });
      const panel = await s.start();

      panel.emitChange("permission-mode", { "permission-mode": "plan" });
      await flush();
      expect(field(currentPanel(s).config, "permission-mode")["value"]).toBe("plan");

      // Switching backends re-fetches the launch options; OpenCode reports no
      // modes, so the field goes away and the remembered "plan" cannot leak.
      currentPanel(s).emitChange("agent", { agent: "opencode" });
      await flush();
      expect(sectionById(currentPanel(s).config, "permission-mode")).toBeUndefined();

      // Coming back to a backend that DOES offer modes must not resurrect a
      // mode the user picked for a different one.
      currentPanel(s).emitChange("agent", { agent: "claude" });
      await flush();
      expect(field(currentPanel(s).config, "permission-mode")["value"]).toBe("plan");
    });
  });
});
