/**
 * Tests for the EmptyState component.
 *
 * Note: EmptyState is a simple message-only component that guides users
 * to open a project by pressing Alt+X Enter.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import EmptyState from "./EmptyState.svelte";

describe("EmptyState component", () => {
  it("renders guidance message for opening a project", () => {
    render(EmptyState);

    expect(screen.getByText(/No projects open\./)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) => element?.textContent === "Press Alt+X+Enter to open a project."
      )
    ).toBeInTheDocument();
  });

  it("does not render any buttons", () => {
    render(EmptyState);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
