/**
 * Tests for StartupView — the four first-run / boot startup surfaces rendered
 * from the snapshot's `main` field. Gestures are fire-and-forget ui:events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";

const { mockApi } = vi.hoisted(() => ({
  mockApi: { emitEvent: vi.fn() },
}));

vi.mock("$lib/api", () => mockApi);

import StartupView from "./StartupView.svelte";
import type { UiAgentOption, UiSetupRow } from "@shared/ui-state";

describe("StartupView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the boot splash for the starting kind", () => {
    render(StartupView, { props: { main: { kind: "starting" } } });
    expect(screen.getByText(/CodeHydra is starting/i)).toBeInTheDocument();
  });

  it("renders the loading label for the loading kind", () => {
    render(StartupView, { props: { main: { kind: "loading", label: "Loading workspace..." } } });
    expect(screen.getByText("Loading workspace...")).toBeInTheDocument();
  });

  it("renders setup rows and no actions without an error", () => {
    const rows: UiSetupRow[] = [
      { id: "vscode", label: "VSCode", status: "done" },
      { id: "agent", label: "Agent", status: "running", message: "Downloading" },
      { id: "setup", label: "Setup", status: "pending" },
    ];
    render(StartupView, { props: { main: { kind: "setup", rows } } });

    expect(screen.getByText("VSCode")).toBeInTheDocument();
    expect(screen.getByText("Downloading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows the error message + Retry/Quit and emits the matching ui:events", async () => {
    const rows: UiSetupRow[] = [{ id: "setup", label: "Setup", status: "error" }];
    render(StartupView, {
      props: { main: { kind: "setup", rows, error: { message: "it broke" } } },
    });

    expect(screen.getByText("it broke")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "setup-retry" });

    await fireEvent.click(screen.getByRole("button", { name: "Quit" }));
    expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "setup-quit" });
  });

  it("agent-selection: seeds the first option, lets the user pick, and emits on Continue", async () => {
    const agents: UiAgentOption[] = [
      { agent: "claude", label: "Claude", icon: "sparkle" },
      { agent: "opencode", label: "OpenCode", icon: "terminal" },
    ];
    render(StartupView, { props: { main: { kind: "agent-selection", agents } } });

    // The first option is seeded as checked.
    expect(screen.getByRole("radio", { name: /claude/i })).toHaveAttribute("aria-checked", "true");

    await fireEvent.click(screen.getByRole("radio", { name: /opencode/i }));
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(mockApi.emitEvent).toHaveBeenCalledWith({ kind: "agent-selected", agent: "opencode" });
  });
});
