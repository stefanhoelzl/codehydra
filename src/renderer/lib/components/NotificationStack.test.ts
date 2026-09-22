/**
 * Tests for the NotificationStack component.
 *
 * The repeat badge is the only place a collapsed card's count becomes visible —
 * so its edges (absent at one, capped at three digits) and its placement (in
 * the label, never over the type icon) are pinned here.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { UiNotification } from "@shared/ui-state";
import type { Api } from "@shared/electron-api";
import { createMockApi } from "../test-utils";

// The component imports $lib/api for the dismiss button, which throws at import
// time without a window.api. Shared fake: src/renderer/lib/api/__mocks__/index.ts
const mockApi: Api = createMockApi();
window.api = mockApi;
vi.mock("$lib/api");

import NotificationStack from "./NotificationStack.svelte";
import { emitEvent } from "$lib/api";

function notification(
  count: number | undefined,
  title = 'Failed to create "ws-1"'
): UiNotification {
  return {
    id: "ntf-1",
    config: { type: "error", title, message: "Branch is already checked out", dismissible: true },
    ...(count === undefined ? {} : { count }),
  };
}

function renderStack(entry: UiNotification, isExpanded = true): void {
  render(NotificationStack, { props: { notifications: [entry], isExpanded } });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("NotificationStack repeat badge", () => {
  it("shows no badge for a notification that happened once", () => {
    renderStack(notification(1));

    expect(screen.getByRole("status")).toHaveTextContent("Failed to create");
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("shows no badge when the count is absent", () => {
    renderStack(notification(undefined));

    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("shows the count from two", () => {
    renderStack(notification(2));

    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows an exact count up to 99", () => {
    renderStack(notification(98));

    expect(screen.getByText("98")).toBeInTheDocument();
  });

  it("saturates the label past 99 so it stays inside the icon cell", () => {
    renderStack(notification(250));

    expect(screen.getByText("99+")).toBeInTheDocument();
    expect(screen.queryByText("250")).not.toBeInTheDocument();
  });

  it("announces the repeat, since the icon cell is aria-hidden", () => {
    renderStack(notification(98));

    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      'Failed to create "ws-1" (98)'
    );
  });

  it("leaves the label alone for a card that happened once", () => {
    renderStack(notification(1));

    expect(screen.getByRole("status")).toHaveAttribute("aria-label", 'Failed to create "ws-1"');
  });

  it("puts the badge in the label, not over the type icon", () => {
    // In the 20px icon cell the badge covered the icon and overhung the
    // sidebar's right edge, growing a horizontal scrollbar.
    renderStack(notification(7));

    const badge = screen.getByText("7");
    expect(badge.closest(".notification-label")).not.toBeNull();
    expect(badge.closest(".notification-indicator")).toBeNull();
  });
});

describe("NotificationStack attached card", () => {
  const attached: UiNotification = {
    id: "ntf-2",
    config: { type: "info", title: "Tests green", dismissible: true },
    workspace: { key: "p1/feat", name: "Login form" },
  };

  it("names the workspace it is about", () => {
    renderStack(attached);

    expect(screen.getByText("Login form")).toBeInTheDocument();
  });

  it("switches to the workspace when its title is clicked", () => {
    renderStack(attached);

    screen.getByRole("button", { name: "Tests green" }).click();

    expect(emitEvent).toHaveBeenCalledWith({ kind: "switch-workspace", key: "p1/feat" });
  });

  it("renders an unattached title as plain text", () => {
    renderStack(notification(1, "Update available"));

    expect(screen.queryByRole("button", { name: "Update available" })).not.toBeInTheDocument();
  });
});
