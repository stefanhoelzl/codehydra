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

// Mock the API used by the panel and its child dropdowns.
const mockApi = vi.hoisted(() => ({
  workspaces: { create: vi.fn().mockResolvedValue({}) },
  projects: {
    fetchBases: vi.fn().mockResolvedValue({ bases: [] }),
    open: vi.fn().mockResolvedValue(null),
  },
  on: vi.fn(() => () => {}),
}));
vi.mock("$lib/api", () => mockApi);

import NewWorkspaceView from "./NewWorkspaceView.svelte";
import * as projectsStore from "$lib/stores/projects.svelte.js";
import * as newWorkspaceViewStore from "$lib/stores/new-workspace-view.svelte.js";
import * as bootstrapStore from "$lib/stores/bootstrap.svelte.js";
import * as pendingStore from "$lib/stores/pending-workspaces.svelte.js";
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
    projectsStore.reset();
    newWorkspaceViewStore.reset();
    pendingStore.reset();
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
      pendingStore.createPendingPath(PROJECT_PATH, "feature-x")
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
      pendingStore.createPendingPath(PROJECT_PATH, "feature-y")
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
