/**
 * Integration tests for MainView's close-project gesture: sidebar click →
 * close-project ui:event. The confirmation dialog and the close orchestration
 * are main-side now (presenter close-confirm hook); their flows are covered
 * by src/modules/presentation-module.integration.test.ts and the
 * close-project operation tests.
 *
 * Workspace/project data is passed in as the `ui` prop (the onState
 * subscription is owned by App.svelte; MainView is a render function over the
 * snapshot).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/svelte";
import type { UiState } from "@shared/ui-state";

const { mockApi } = vi.hoisted(() => {
  return {
    mockApi: {
      emitEvent: vi.fn(),
      projects: {
        open: vi.fn().mockResolvedValue({}),
      },
      workspaces: {
        hibernate: vi.fn().mockResolvedValue({ started: true }),
        wake: vi.fn().mockResolvedValue(null),
      },
      ui: {
        switchWorkspace: vi.fn().mockResolvedValue(undefined),
      },
      lifecycle: {
        ready: vi.fn().mockResolvedValue({ defaultAgent: null, availableAgents: [] }),
        quit: vi.fn().mockResolvedValue(undefined),
      },
      on: vi.fn(() => vi.fn()),
      onState: vi.fn(() => vi.fn()),
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
import { makeUiState, makeUiProjectRow, makeUiWorkspaceRow } from "$lib/test-utils";

let current: UiState;
let rerenderView: (props: { ui: UiState }) => Promise<void>;

function pushState(state: UiState): Promise<void> {
  current = state;
  return rerenderView({ ui: current });
}

const projectWithWorkspaces = makeUiProjectRow(
  [makeUiWorkspaceRow("feature-1"), makeUiWorkspaceRow("feature-2")],
  { id: "test-project-12345678", name: "test-project" }
);

const projectWithoutWorkspaces = makeUiProjectRow([], {
  id: "empty-project-87654321",
  name: "empty-project",
});

const SNAPSHOT = makeUiState([projectWithWorkspaces, projectWithoutWorkspaces]);

async function renderWithSnapshot(): Promise<void> {
  current = SNAPSHOT;
  const result = render(MainView, { props: { ui: current } });
  rerenderView = result.rerender;
  await waitFor(() => expect(screen.getByText("test-project")).toBeInTheDocument());
}

describe("MainView close project integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("emits close-project when clicking close on a project with workspaces", async () => {
    await renderWithSnapshot();

    // Button has id="close-project-${project.id}"
    const closeButton = document.getElementById(`close-project-${projectWithWorkspaces.id}`);
    expect(closeButton).toBeInTheDocument();
    await fireEvent.click(closeButton!);

    expect(mockApi.emitEvent).toHaveBeenCalledWith({
      kind: "close-project",
      projectId: projectWithWorkspaces.id,
    });
  });

  it("emits close-project for a project with no workspaces (user still confirms main-side)", async () => {
    await renderWithSnapshot();

    const closeButton = document.getElementById(`close-project-${projectWithoutWorkspaces.id}`);
    expect(closeButton).toBeInTheDocument();
    await fireEvent.click(closeButton!);

    expect(mockApi.emitEvent).toHaveBeenCalledWith({
      kind: "close-project",
      projectId: projectWithoutWorkspaces.id,
    });
  });

  it("ignores close for a project missing from the snapshot (race condition)", async () => {
    await renderWithSnapshot();

    // The project disappears (e.g. closed elsewhere) before the click lands.
    const closeButton = document.getElementById(`close-project-${projectWithWorkspaces.id}`);
    await pushState(makeUiState([projectWithoutWorkspaces]));
    await fireEvent.click(closeButton!);

    expect(mockApi.emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "close-project", projectId: projectWithWorkspaces.id })
    );
  });
});
