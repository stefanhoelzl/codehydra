/**
 * Tests for the NotificationStack component.
 *
 * The repeat badge is the only place a collapsed card's count becomes visible,
 * and it is the piece that has to survive the sidebar collapsing to bare icons —
 * so its edges (absent at one, capped at three digits) are pinned here.
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

  it("still renders the badge while the sidebar is collapsed", () => {
    renderStack(notification(7), false);

    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
