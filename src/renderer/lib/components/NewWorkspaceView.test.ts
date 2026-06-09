/**
 * Tests for the NewWorkspaceView panel — focused on the create/submit behavior
 * that differs from the old dialog:
 * - With a queued prompt: background create (stealFocus:false), no switch, stay on view.
 * - Without a prompt: switch to the new workspace and close the view.
 * - Escape clears the form; Alt+X+Enter (requestSubmit) triggers Create.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import { asProjectId } from "@shared/test-fixtures";

// Mock the API used by the panel and its child dropdowns. `on` keeps a real
// handler registry so tests can push events (e.g. project:bases-updated) to
// the mounted child dropdowns via emitApiEvent.
const mockApi = vi.hoisted(() => {
  const eventHandlers = new Map<string, Set<(event: unknown) => void>>();
  return {
    workspaces: { create: vi.fn().mockResolvedValue({}) },
    projects: {
      fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
      open: vi.fn().mockResolvedValue(null),
    },
    on: vi.fn((event: string, handler: (e: unknown) => void) => {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    eventHandlers,
  };
});
vi.mock("$lib/api", () => mockApi);

function emitApiEvent(event: string, payload: unknown): void {
  mockApi.eventHandlers.get(event)?.forEach((handler) => handler(payload));
}

import NewWorkspaceView from "./NewWorkspaceView.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as newWorkspaceViewStore from "$lib/stores/new-workspace-view.svelte.js";
import * as bootstrapStore from "$lib/stores/bootstrap.svelte.js";
import * as lifecycleStore from "$lib/stores/workspace-lifecycle.svelte.js";
import type { Project } from "@shared/api/types";

const PROJECT_ID = asProjectId("test-project-12345678");
const PROJECT_PATH = "/test/project";

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    name: "test-project",
    path: PROJECT_PATH,
    defaultBaseBranch: "main",
    workspaces: [],
  };
}

// Drive the (component-local) name field via its combobox input.
async function typeName(value: string): Promise<void> {
  const nameInput = document.getElementById("workspace-name-input") as HTMLInputElement;
  expect(nameInput).not.toBeNull();
  await fireEvent.input(nameInput, { target: { value } });
}

describe("NewWorkspaceView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.eventHandlers.clear();
    projectsStore.reset();
    newWorkspaceViewStore.reset();
    lifecycleStore.reset();
    bootstrapStore.setBootstrap({ defaultAgent: null, availableAgents: [] });
    projectsStore.setProjects([makeProject()]);
    newWorkspaceViewStore.openNewWorkspaceView();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("creates with a prompt, switches to the new workspace, and closes the view", async () => {
    render(NewWorkspaceView, { props: { open: true } });

    await typeName("feature-x");

    const promptEl = document.getElementById("initial-prompt") as HTMLTextAreaElement;
    await fireEvent.input(promptEl, { target: { value: "Implement login" } });

    await fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockApi.workspaces.create).toHaveBeenCalledTimes(1);
    });
    const [path, name, branch, options] = mockApi.workspaces.create.mock.calls[0]!;
    expect(path).toBe(PROJECT_PATH);
    expect(name).toBe("feature-x");
    expect(branch).toBe("main");
    // initialPrompt is forwarded; stealFocus is NOT set, so the main process
    // switches to the new workspace as visual confirmation that it was created.
    expect(options).toEqual({ initialPrompt: "Implement login" });

    // Switched to the placeholder workspace and left the view.
    expect(projectsStore.activeWorkspacePath.value).toBe(
      lifecycleStore.createPendingPath(PROJECT_PATH, "feature-x")
    );
    expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
  });

  it("switches to the new workspace and closes the view when no prompt is given", async () => {
    render(NewWorkspaceView, { props: { open: true } });

    await typeName("feature-y");

    await fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockApi.workspaces.create).toHaveBeenCalledTimes(1);
    });
    const [, , , options] = mockApi.workspaces.create.mock.calls[0]!;
    // No prompt → no options object → default (switching) behavior.
    expect(options).toBeUndefined();

    // Switched to the placeholder workspace and left the view.
    expect(projectsStore.activeWorkspacePath.value).toBe(
      lifecycleStore.createPendingPath(PROJECT_PATH, "feature-y")
    );
    expect(newWorkspaceViewStore.newWorkspaceView.isOpen).toBe(false);
  });

  it("re-enables fields after a no-prompt submit so the next visit isn't stuck", async () => {
    // Regression: previously the no-prompt branch closed the view without
    // resetting isSubmitting, so on reopen every field was disabled.
    const { rerender } = render(NewWorkspaceView, { props: { open: true } });

    await typeName("first");
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mockApi.workspaces.create).toHaveBeenCalledTimes(1));

    // Simulate the user navigating back to the view (close → reopen).
    newWorkspaceViewStore.openNewWorkspaceView();
    await rerender({ open: true });

    // Name field is interactive (the form was reset, isSubmitting cleared).
    const nameInput = document.getElementById("workspace-name-input") as HTMLInputElement;
    expect(nameInput.disabled).toBe(false);

    await typeName("second");
    const createButton = screen.getByRole("button", { name: "Create" });
    await waitFor(() => expect(createButton).not.toBeDisabled());
  });

  it("survives a stale default branch and heals to the fresh one (no effect loop)", async () => {
    // Regression: the project's defaultBaseBranch went stale during the session
    // (remote default-branch rename master → main). The auto-fill effect and
    // BranchDropdown's clear-invalid-value validation ping-ponged forever,
    // crashing Svelte with effect_update_depth_exceeded and bricking the UI.
    projectsStore.setProjectDefaultBaseBranch(PROJECT_PATH, "origin/master");
    // Cached branch list still contains the stale branch.
    mockApi.projects.fetchBases.mockResolvedValue({
      bases: [{ name: "origin/master", isRemote: true }],
    });

    render(NewWorkspaceView, { props: { open: true } });

    const branchInput = document.getElementById(
      `branch-dropdown-${PROJECT_PATH}-input`
    ) as HTMLInputElement;
    await waitFor(() => expect(branchInput.value).toBe("origin/master"));

    // Background refresh pruned the stale branch; the event heals the store
    // default (as the domain-event binding does) and updates the dropdown.
    emitApiEvent("project:bases-updated", {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      bases: [{ name: "origin/main", isRemote: true }],
      defaultBaseBranch: "origin/main",
    });
    projectsStore.setProjectDefaultBaseBranch(PROJECT_PATH, "origin/main");

    // No crash, and the selection healed to the fresh default.
    await waitFor(() => expect(branchInput.value).toBe("origin/main"));

    // Form is fully usable: Create enables once a name is typed.
    await typeName("snap");
    const createButton = screen.getByRole("button", { name: "Create" });
    await waitFor(() => expect(createButton).not.toBeDisabled());
  });

  it("does not re-fetch bases when a bases-updated event rewrites the project (fetch loop regression)", async () => {
    // Regression: every bases:updated event rewrote the projects store, handing
    // out a new project object. The dropdowns' fetch effects were keyed on that
    // identity (via the projectPath prop expression), so each event re-triggered
    // fetchBases — whose background refresh emitted the next event: a
    // self-amplifying loop of git fetches that kept the spinner loading forever.
    mockApi.projects.fetchBases.mockResolvedValue({
      bases: [{ name: "main", isRemote: false }],
    });

    render(NewWorkspaceView, { props: { open: true } });

    // The view fetches once per project selection (shared by both dropdowns).
    await waitFor(() => expect(mockApi.projects.fetchBases).toHaveBeenCalledTimes(1));

    // A refresh completes: the event plus a store rewrite that changes the
    // project's object identity (fresh default), as the domain-event binding does.
    emitApiEvent("project:bases-updated", {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      bases: [
        { name: "main", isRemote: false },
        { name: "develop", isRemote: false },
      ],
      defaultBaseBranch: "develop",
    });
    projectsStore.setProjectDefaultBaseBranch(PROJECT_PATH, "develop");

    // Let any (rogue) effect re-runs and their async fetches settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // No additional fetches, and the spinner stays settled.
    expect(mockApi.projects.fetchBases).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status", { name: "Loading branches" })).toBeNull();
  });

  it("does not override a manual branch pick when a fresh default arrives", async () => {
    mockApi.projects.fetchBases.mockResolvedValue({
      bases: [
        { name: "develop", isRemote: false },
        { name: "origin/main", isRemote: true },
      ],
    });

    render(NewWorkspaceView, { props: { open: true } });

    const branchInput = document.getElementById(
      `branch-dropdown-${PROJECT_PATH}-input`
    ) as HTMLInputElement;
    // Default ("main" from makeProject) is not in the list; pick manually.
    emitApiEvent("project:bases-updated", {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      bases: [
        { name: "develop", isRemote: false },
        { name: "origin/main", isRemote: true },
      ],
      defaultBaseBranch: "origin/main",
    });
    await fireEvent.focus(branchInput);
    await waitFor(() => {
      const option = screen.getByText("develop");
      expect(option).not.toBeNull();
    });
    await fireEvent.mouseDown(screen.getByText("develop"));
    await waitFor(() => expect(branchInput.value).toBe("develop"));

    // Fresh default arriving later must not clobber the manual pick.
    projectsStore.setProjectDefaultBaseBranch(PROJECT_PATH, "origin/main");
    emitApiEvent("project:bases-updated", {
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      bases: [
        { name: "develop", isRemote: false },
        { name: "origin/main", isRemote: true },
      ],
      defaultBaseBranch: "origin/main",
    });

    await waitFor(() => expect(branchInput.value).toBe("develop"));
  });

  it("clears the form on Escape", async () => {
    render(NewWorkspaceView, { props: { open: true } });

    await typeName("scratch");
    const createButton = screen.getByRole("button", { name: "Create" });
    await waitFor(() => expect(createButton).not.toBeDisabled());

    await fireEvent.keyDown(screen.getByRole("region", { name: "New workspace" }), {
      key: "Escape",
    });

    // Name cleared → form invalid → Create disabled, nothing created.
    await waitFor(() => expect(createButton).toBeDisabled());
    expect(mockApi.workspaces.create).not.toHaveBeenCalled();
  });

  it("Alt+X+Enter (requestSubmit) triggers Create", async () => {
    render(NewWorkspaceView, { props: { open: true } });

    await typeName("via-shortcut");

    // Simulate the shortcut handler asking the mounted view to submit.
    newWorkspaceViewStore.requestSubmit();

    await waitFor(() => {
      expect(mockApi.workspaces.create).toHaveBeenCalledTimes(1);
    });
    expect(mockApi.workspaces.create.mock.calls[0]![1]).toBe("via-shortcut");
  });
});
