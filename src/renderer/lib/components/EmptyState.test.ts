/**
 * Tests for the EmptyState component.
 *
 * Note: EmptyState is a simple message-only component.
 * The "Open Project" button is rendered separately in Sidebar's footer
 * to ensure consistent positioning regardless of project state.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import EmptyState from "./EmptyState.svelte";

describe("EmptyState component", () => {
  it('renders "No projects open" message', () => {
    render(EmptyState);

    expect(screen.getByText("No projects open.")).toBeInTheDocument();
  });

  it("does not render any buttons (button is in Sidebar footer)", () => {
    render(EmptyState);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
