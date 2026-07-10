/**
 * Tests for setupDomainEventBindings — the agent notification chime, driven off
 * ui:state snapshots (it feeds every workspace's agent counts to the chime
 * service and drops tracking for workspaces that leave the snapshot).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStatus } from "@shared/api/types";
import type { UiState, UiWorkspaceRow } from "@shared/ui-state";

// Shared fake: src/renderer/lib/api/__mocks__/index.ts
vi.mock("$lib/api");

import { setupDomainEventBindings, type OnState } from "./setup-domain-event-bindings";
import { AgentNotificationService } from "$lib/services/agent-notifications";

const KEY = "my-project-a1b2c3d4/feature-branch";

function row(key: string, agent: AgentStatus): UiWorkspaceRow {
  return { key, name: key, status: "ready", hibernated: false, agent, tags: [], active: false };
}

function makeState(workspaces: UiWorkspaceRow[]): UiState {
  return {
    sidebar: {
      projects: [{ id: "p", name: "p", title: "/p", remote: false, workspaces }],
      width: 250,
    },
    frames: {},
    main: { kind: "creation" },
    theme: "dark",
    labelScroll: "hover",
    silent: false,
    mode: "hover",
    capturing: false,
    dialogs: [],
    notifications: [],
  };
}

/** A controllable onState: capture the callback, push snapshots on demand. */
function createOnState(): { onState: OnState; push: (state: UiState) => void } {
  let cb: ((state: UiState) => void) | null = null;
  const onState: OnState = (callback) => {
    cb = callback;
    return () => {
      cb = null;
    };
  };
  return { onState, push: (state) => cb?.(state) };
}

describe("setupDomainEventBindings (chime from snapshots)", () => {
  let notificationService: AgentNotificationService;

  beforeEach(() => {
    notificationService = new AgentNotificationService();
    vi.spyOn(notificationService, "handleStatusChange");
    vi.spyOn(notificationService, "removeWorkspace");
  });

  it("forwards each workspace's agent counts to the chime service", () => {
    const { onState, push } = createOnState();
    setupDomainEventBindings(notificationService, onState);

    push(makeState([row(KEY, { type: "busy", counts: { idle: 1, busy: 2, total: 3 } })]));

    expect(notificationService.handleStatusChange).toHaveBeenCalledWith(KEY, {
      idle: 1,
      busy: 2,
      total: 3,
    });
  });

  it("treats agent 'none' as zero counts (gray → green later still chimes)", () => {
    const { onState, push } = createOnState();
    setupDomainEventBindings(notificationService, onState);

    push(makeState([row(KEY, { type: "none" })]));

    expect(notificationService.handleStatusChange).toHaveBeenCalledWith(KEY, { idle: 0, busy: 0 });
  });

  it("drops chime tracking when a workspace leaves the snapshot", () => {
    const { onState, push } = createOnState();
    setupDomainEventBindings(notificationService, onState);

    push(makeState([row(KEY, { type: "idle", counts: { idle: 1, busy: 0, total: 1 } })]));
    push(makeState([])); // workspace removed

    expect(notificationService.removeWorkspace).toHaveBeenCalledWith(KEY);
  });

  it("unsubscribes when cleanup is called", () => {
    const { onState, push } = createOnState();
    const cleanup = setupDomainEventBindings(notificationService, onState);

    cleanup();
    push(makeState([row(KEY, { type: "idle", counts: { idle: 1, busy: 0, total: 1 } })]));

    expect(notificationService.handleStatusChange).not.toHaveBeenCalled();
  });
});
