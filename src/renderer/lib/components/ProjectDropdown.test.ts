/**
 * Tests for the ProjectDropdown component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import type { ProjectPath } from "@shared/ipc";
import type { ProjectId } from "@shared/api/types";

// Create mock projects function
const { mockProjects } = vi.hoisted(() => ({
  mockProjects: vi.fn(),
}));

// Mock $lib/stores/projects
vi.mock("$lib/stores/projects.svelte.js", () => ({
  projects: {
    get value() {
      return mockProjects();
    },
  },
}));

// Import component after mock setup
import ProjectDropdown from "./ProjectDropdown.svelte";

// Test project IDs
const alphaProjectId = "project-alpha-12345678" as ProjectId;
const betaProjectId = "project-beta-87654321" as ProjectId;
const anotherProjectId = "another-project-11111111" as ProjectId;

describe("ProjectDropdown component", () => {
  // Projects with IDs for the new v2 API
  const mockProjectsList = [
    {
      id: alphaProjectId,
      path: "/home/user/projects/project-alpha" as ProjectPath,
      name: "project-alpha",
      workspaces: [],
    },
    {
      id: betaProjectId,
      path: "/home/user/projects/project-beta" as ProjectPath,
      name: "project-beta",
      workspaces: [],
    },
    {
      id: anotherProjectId,
      path: "/home/user/projects/another-project" as ProjectPath,
      name: "another-project",
      workspaces: [],
    },
  ];

  const defaultProps = {
    value: alphaProjectId,
    onSelect: vi.fn(),
  };

  /**
   * Helper to focus input and open dropdown.
   * When dropdown has a value, there's a 50ms delay before opening.
   */
  async function focusAndOpenDropdown(input: HTMLElement): Promise<void> {
    await fireEvent.focus(input);
    await vi.advanceTimersByTimeAsync(50);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProjects.mockReturnValue(mockProjectsList);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("rendering", () => {
    it("renders all open projects", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      expect(screen.getByText("project-alpha")).toBeInTheDocument();
      expect(screen.getByText("project-beta")).toBeInTheDocument();
      expect(screen.getByText("another-project")).toBeInTheDocument();
    });

    it("displays project name as label", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveTextContent("project-alpha");
      expect(options[1]).toHaveTextContent("project-beta");
      expect(options[2]).toHaveTextContent("another-project");
    });

    it("onSelect returns project ID (not name or path)", async () => {
      const onSelect = vi.fn();
      render(ProjectDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      const option = screen.getByText("project-beta");
      await fireEvent.mouseDown(option);

      // Should return the project ID, not the path
      expect(onSelect).toHaveBeenCalledWith(betaProjectId);
    });

    it("displays current value in input (shows project name)", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox") as HTMLInputElement;
      // The value prop is the path, but display should be the name
      expect(input.value).toBe("project-alpha");
    });
  });

  describe("filtering", () => {
    it("filters projects by name", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);
      await fireEvent.input(input, { target: { value: "beta" } });

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      expect(screen.queryByText("project-alpha")).not.toBeInTheDocument();
      expect(screen.getByText("project-beta")).toBeInTheDocument();
      expect(screen.queryByText("another-project")).not.toBeInTheDocument();
    });

    it("filter is case-insensitive", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);
      await fireEvent.input(input, { target: { value: "ALPHA" } });

      await vi.advanceTimersByTimeAsync(250);
      await tick();

      expect(screen.getByText("project-alpha")).toBeInTheDocument();
      expect(screen.queryByText("project-beta")).not.toBeInTheDocument();
    });
  });

  describe("keyboard navigation", () => {
    it("Arrow Down moves to next option", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      // ArrowDown opens the dropdown immediately
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Enter selects highlighted option", async () => {
      const onSelect = vi.fn();
      render(ProjectDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      // ArrowDown opens the dropdown immediately
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Enter" });

      // Should return project ID, not path
      expect(onSelect).toHaveBeenCalledWith(alphaProjectId);
    });

    it("Escape closes dropdown without selecting", async () => {
      const onSelect = vi.fn();
      render(ProjectDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);
      expect(input).toHaveAttribute("aria-expanded", "true");

      await fireEvent.keyDown(input, { key: "Escape" });

      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe("long project names", () => {
    it("handles very long project names without layout break", async () => {
      const longProjectName = "this-is-a-very-long-project-name-that-should-still-work-properly";
      const longProjectId = "long-project-12345678" as ProjectId;
      mockProjects.mockReturnValue([
        {
          id: longProjectId,
          path: `/home/user/${longProjectName}` as ProjectPath,
          name: longProjectName,
          workspaces: [],
        },
      ]);

      render(ProjectDropdown, {
        props: { ...defaultProps, value: longProjectId },
      });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      const option = screen.getByText(longProjectName);
      expect(option).toBeInTheDocument();

      // Verify we can select it
      await fireEvent.mouseDown(option);
      // No error should occur
    });
  });

  describe("disabled state", () => {
    it("disabled prop prevents interaction", async () => {
      render(ProjectDropdown, { props: { ...defaultProps, disabled: true } });

      const input = screen.getByRole("combobox");
      expect(input).toBeDisabled();

      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "false");
    });
  });

  describe("accessibility", () => {
    it("has correct ARIA attributes", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(input).toHaveAttribute("aria-haspopup", "listbox");
      expect(input).toHaveAttribute("aria-autocomplete", "list");
    });

    it("options have correct role", async () => {
      render(ProjectDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(3);
    });
  });
});
