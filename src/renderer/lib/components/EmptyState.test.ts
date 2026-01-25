/**
 * Tests for the EmptyState component.
 *
 * Note: EmptyState is a simple message-only component that guides users
 * to open a project via the Create Workspace dialog's folder icon.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import EmptyState from "./EmptyState.svelte";

describe("EmptyState component", () => {
  it("renders guidance message for opening a project", () => {
    render(EmptyState);

    expect(
      screen.getByText(
        /No projects open\. Click the \+ button on a project header to create a workspace, or open a project via the Create Workspace dialog\./
      )
    ).toBeInTheDocument();
  });

  it("does not render any buttons", () => {
    render(EmptyState);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
