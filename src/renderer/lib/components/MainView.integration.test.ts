/**
 * Integration tests for MainView: the close-project flow from sidebar click
 * through the dialog to the API calls.
 *
 * Workspace/project data arrives as UiState snapshots pushed through the
 * captured onState callback (real holder, real components).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/svelte";
import type { UiState } from "@shared/ui-state";

type StateCallback = (state: UiState) => void;
const { mockApi, stateCallbacks } = vi.hoisted(() => {
  const stateCallbacks: Array<(state: unknown) => void> = [];
  return {
    stateCallbacks,
    mockApi: {
      emitEvent: vi.fn(),
      projects: {
        open: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
      },
      workspaces: {
        remove: vi.fn().mockResolvedValue({ started: true }),
        getStatus: vi
          .fn()
          .mockResolvedValue({ isDirty: false, unmergedCommits: 0, agent: { type: "none" } }),
        hibernate: vi.fn().mockResolvedValue({ started: true }),
        wake: vi.fn().mockResolvedValue(null),
      },
      ui: {
        switchWorkspace: vi.fn().mockResolvedValue(undefined),
        setMode: vi.fn().mockResolvedValue(undefined),
      },
      lifecycle: {
        ready: vi.fn().mockResolvedValue({ defaultAgent: null, availableAgents: [] }),
        quit: vi.fn().mockResolvedValue(undefined),
      },
      on: vi.fn(() => vi.fn()),
      onState: vi.fn((callback: (state: unknown) => void) => {
        stateCallbacks.push(callback);
        return vi.fn();
      }),
      sendDialogEvent: vi.fn(),
      sendNotificationEvent: vi.fn(),
    },
  };
});

vi.mock("$lib/api", () => mockApi);

// Mock AgentNotificationService
const { MockAgentNotificationService } = vi.hoisted(() => {
  class MockAgentNotificationService {
    handleStatusChange = vi.fn();
    removeWorkspace = vi.fn();
    reset = vi.fn();
  }
  return { MockAgentNotificationService };
});

vi.mock("$lib/services/agent-notifications", () => ({
  AgentNotificationService: MockAgentNotificationService,
}));

// Import after mock setup
import MainView from "./MainView.svelte";
import * as dialogsStore from "$lib/stores/dialogs.svelte.js";
import * as shortcutsStore from "$lib/stores/shortcuts.svelte.js";
import { resetUiState } from "$lib/stores/ui-state.svelte.js";
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";
import { asProjectId } from "@shared/test-fixtures";

function pushState(state: UiState): void {
  expect(stateCallbacks.length).toBeGreaterThan(0);
  for (const callback of stateCallbacks as StateCallback[]) {
    callback(state);
  }
}

const projectWithWorkspaces = makeUiProjectRow(
  [
    makeUiWorkspaceRow("feature-1", { path: "/test/.worktrees/feature-1" }),
    makeUiWorkspaceRow("feature-2", { path: "/test/.worktrees/feature-2" }),
  ],
  { id: "test-project-12345678", path: "/test/project", name: "test-project" }
);

const projectWithoutWorkspaces = makeUiProjectRow([], {
  id: "empty-project-87654321",
  path: "/test/empty-project",
  name: "empty-project",
});

const SNAPSHOT = makeUiState([projectWithWorkspaces, projectWithoutWorkspaces]);

async function renderWithSnapshot(): Promise<void> {
  render(MainView);
  await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());
  pushState(SNAPSHOT);
  await waitFor(() => expect(screen.getByText("test-project")).toBeInTheDocument());
}

describe("MainView close project integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateCallbacks.length = 0;
    resetUiState();
    dialogsStore.reset();
    shortcutsStore.reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("handleCloseProject behavior", () => {
    it("opens close-project dialog when clicking close on project with workspaces", async () => {
      await renderWithSnapshot();

      // Button has id="close-project-${project.id}"
      const closeButton = document.getElementById(`close-project-${projectWithWorkspaces.id}`);
      expect(closeButton).toBeInTheDocument();
      await fireEvent.click(closeButton!);

      // Dialog should be open
      expect(dialogsStore.dialogState.value.type).toBe("close-project");
      if (dialogsStore.dialogState.value.type === "close-project") {
        expect(dialogsStore.dialogState.value.projectId).toBe(projectWithWorkspaces.id);
      }
    });

    it("shows dialog when clicking close on project with no workspaces", async () => {
      await renderWithSnapshot();

      const closeButton = document.getElementById(`close-project-${projectWithoutWorkspaces.id}`);
      expect(closeButton).toBeInTheDocument();
      await fireEvent.click(closeButton!);

      // Should open dialog even for empty projects - user confirms closing
      expect(mockApi.projects.close).not.toHaveBeenCalled();
      expect(dialogsStore.dialogState.value.type).toBe("close-project");
    });

    it("ignores close for a project missing from the snapshot (race condition)", async () => {
      render(MainView);
      await waitFor(() => expect(mockApi.onState).toHaveBeenCalled());
      pushState(SNAPSHOT);
      await waitFor(() => expect(screen.getByText("test-project")).toBeInTheDocument());

      // The project disappears (e.g. closed elsewhere) before the click lands.
      const closeButton = document.getElementById(`close-project-${projectWithWorkspaces.id}`);
      pushState(makeUiState([projectWithoutWorkspaces]));
      await fireEvent.click(closeButton!);

      expect(mockApi.projects.close).not.toHaveBeenCalled();
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });
  });

  describe("CloseProjectDialog rendering", () => {
    it("renders CloseProjectDialog when dialog type is close-project", async () => {
      await renderWithSnapshot();

      dialogsStore.openCloseProjectDialog(asProjectId(projectWithWorkspaces.id));

      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Close Project" })).toBeInTheDocument();
        expect(screen.getByText(/2 workspaces/)).toBeInTheDocument();
      });
    });
  });

  describe("full close flow without removeAll", () => {
    it("closes project without removing workspaces when checkbox unchecked", async () => {
      await renderWithSnapshot();

      dialogsStore.openCloseProjectDialog(asProjectId(projectWithWorkspaces.id));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

      const dialog = screen.getByRole("dialog");
      const closeButton = within(dialog).getByRole("button", { name: /close project/i });
      await fireEvent.click(closeButton);

      await waitFor(() => {
        expect(mockApi.projects.close).toHaveBeenCalledWith(projectWithWorkspaces.path, undefined);
      });
      // Should only call close, not remove
      expect(mockApi.workspaces.remove).not.toHaveBeenCalled();
      // Dialog should be closed
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });
  });

  describe("full close flow with removeAll", () => {
    it("removes all workspaces then closes project when checkbox checked", async () => {
      await renderWithSnapshot();

      dialogsStore.openCloseProjectDialog(asProjectId(projectWithWorkspaces.id));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

      // Check the checkbox
      const checkbox = document.querySelector("vscode-checkbox") as HTMLElement & {
        checked: boolean;
      };
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      // Button should now say "Remove & Close"
      const removeButton = await screen.findByRole("button", { name: /remove & close/i });
      await fireEvent.click(removeButton);

      await waitFor(() => {
        expect(mockApi.projects.close).toHaveBeenCalledWith(projectWithWorkspaces.path, undefined);
      });

      // Should call remove for each workspace with keepBranch=false (using workspace path)
      expect(mockApi.workspaces.remove).toHaveBeenCalledTimes(2);
      expect(mockApi.workspaces.remove).toHaveBeenCalledWith("/test/.worktrees/feature-1", {
        keepBranch: false,
      });
      expect(mockApi.workspaces.remove).toHaveBeenCalledWith("/test/.worktrees/feature-2", {
        keepBranch: false,
      });

      // Dialog should be closed
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });

    it("closes project even when some workspace removals fail", async () => {
      // First removal succeeds, second fails
      mockApi.workspaces.remove
        .mockResolvedValueOnce({ started: true })
        .mockRejectedValueOnce(new Error("Branch in use"));

      await renderWithSnapshot();

      dialogsStore.openCloseProjectDialog(asProjectId(projectWithWorkspaces.id));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

      // Check the checkbox
      const checkbox = document.querySelector("vscode-checkbox") as HTMLElement & {
        checked: boolean;
      };
      checkbox.checked = true;
      await fireEvent(checkbox, new Event("change", { bubbles: true }));

      const dialog = screen.getByRole("dialog");
      const removeButton = await within(dialog).findByRole("button", { name: /remove & close/i });
      await fireEvent.click(removeButton);

      await waitFor(() => {
        // Project should still be closed despite partial failure
        expect(mockApi.projects.close).toHaveBeenCalledWith(projectWithWorkspaces.path, undefined);
      });
      // Both workspaces should have removal attempted
      expect(mockApi.workspaces.remove).toHaveBeenCalledTimes(2);
      // Dialog should be closed
      expect(dialogsStore.dialogState.value.type).toBe("closed");
    });
  });
});
