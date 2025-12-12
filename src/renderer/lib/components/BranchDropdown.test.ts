/**
 * Tests for the BranchDropdown component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import type { BaseInfo } from "@shared/ipc";

// Mock branches data
const mockLocalBranches: BaseInfo[] = [
  { name: "main", isRemote: false },
  { name: "develop", isRemote: false },
];

const mockRemoteBranches: BaseInfo[] = [
  { name: "origin/main", isRemote: true },
  { name: "origin/feature", isRemote: true },
];

const allBranches = [...mockLocalBranches, ...mockRemoteBranches];

// Use vi.hoisted to create mocks that can be referenced in vi.mock factory
const { mockListBases } = vi.hoisted(() => ({
  mockListBases: vi.fn(),
}));

// Mock $lib/api module
vi.mock("$lib/api", () => ({
  selectFolder: vi.fn().mockResolvedValue(null),
  openProject: vi.fn().mockResolvedValue(undefined),
  closeProject: vi.fn().mockResolvedValue(undefined),
  listProjects: vi.fn().mockResolvedValue({ projects: [], activeWorkspacePath: null }),
  createWorkspace: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
  listBases: mockListBases,
  updateBases: vi.fn().mockResolvedValue(undefined),
  isWorkspaceDirty: vi.fn().mockResolvedValue(false),
  onProjectOpened: vi.fn(() => vi.fn()),
  onProjectClosed: vi.fn(() => vi.fn()),
  onWorkspaceCreated: vi.fn(() => vi.fn()),
  onWorkspaceRemoved: vi.fn(() => vi.fn()),
  onWorkspaceSwitched: vi.fn(() => vi.fn()),
}));

// Import component after mock setup
import BranchDropdown from "./BranchDropdown.svelte";
import { listBases } from "$lib/api";

describe("BranchDropdown component", () => {
  const defaultProps = {
    projectPath: "/test/project",
    value: "",
    onSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset the mock implementation for each test
    mockListBases.mockResolvedValue(allBranches);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("accessibility", () => {
    it("renders with combobox role and aria attributes", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const combobox = screen.getByRole("combobox");
      expect(combobox).toBeInTheDocument();
      expect(combobox).toHaveAttribute("aria-expanded");
      expect(combobox).toHaveAttribute("aria-controls");
    });

    it("aria-expanded reflects dropdown open state", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("aria-expanded", "false");

      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "true");
    });

    it("selected option has aria-selected true", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("aria-activedescendant updates on navigation", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Initial state - no active descendant
      expect(input.getAttribute("aria-activedescendant")).toBeFalsy();

      // Navigate down
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      // Should have an active descendant now
      const activedescendant = input.getAttribute("aria-activedescendant");
      expect(activedescendant).toBeTruthy();
      expect(activedescendant).toContain("branch-option");
    });
  });

  describe("loading", () => {
    it("loads branches using api.listBases(projectPath) on mount", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      expect(listBases).toHaveBeenCalledWith("/test/project");
    });

    it("shows spinner while loading", async () => {
      // Delay the response
      mockListBases.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(allBranches), 1000))
      );

      render(BranchDropdown, { props: defaultProps });

      expect(screen.getByText(/loading/i)).toBeInTheDocument();

      await vi.runAllTimersAsync();
    });

    it("handles listBases error gracefully", async () => {
      mockListBases.mockRejectedValue(new Error("Network error"));

      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      // Should show error state or empty list, not crash
      expect(screen.queryByRole("alert")).toBeInTheDocument();
    });
  });

  describe("display", () => {
    it("displays Local and Remote branch groups", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      expect(screen.getByText("Local Branches")).toBeInTheDocument();
      expect(screen.getByText("Remote Branches")).toBeInTheDocument();
    });

    it('shows "No branches found" when filter has no matches', async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "nonexistent" } });

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(300);
      // Flush Svelte's microtask queue
      await tick();

      expect(screen.getByText(/no branches found/i)).toBeInTheDocument();
    });
  });

  describe("debounce", () => {
    it("typing doesn't filter immediately", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "dev" } });

      // All branches should still be visible immediately
      expect(screen.getByText("main")).toBeInTheDocument();
    });

    it("filter applies after 200ms debounce", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "dev" } });

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(250);
      // Flush Svelte's microtask queue
      await tick();

      // Now only "develop" should match
      expect(screen.getByText("develop")).toBeInTheDocument();
      expect(screen.queryByText("main")).not.toBeInTheDocument();
    });

    it("rapid typing resets debounce timer", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Type rapidly
      await fireEvent.input(input, { target: { value: "m" } });
      await vi.advanceTimersByTimeAsync(100);
      await fireEvent.input(input, { target: { value: "ma" } });
      await vi.advanceTimersByTimeAsync(100);
      await fireEvent.input(input, { target: { value: "mai" } });

      // Not enough time has passed since last input
      expect(screen.getByText("develop")).toBeInTheDocument();

      // Now wait for debounce
      await vi.advanceTimersByTimeAsync(250);
      // Flush Svelte's microtask queue
      await tick();

      // Should filter to "main" and "origin/main"
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.queryByText("develop")).not.toBeInTheDocument();
    });
  });

  describe("keyboard navigation", () => {
    it("Arrow Down moves to next option", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      // First option should be highlighted
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Arrow Up moves to previous option", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Go down twice, then up once
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "ArrowUp" });

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Arrow Down at last option wraps to first", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Navigate to last option (4 branches total)
      for (let i = 0; i < 4; i++) {
        await fireEvent.keyDown(input, { key: "ArrowDown" });
      }

      // Should be at last option (index 3)
      let options = screen.getAllByRole("option");
      expect(options[3]).toHaveAttribute("aria-selected", "true");

      // One more ArrowDown should wrap to first
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Arrow Up at first option wraps to last", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Go down to first option
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      // First option should be selected
      let options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");

      // ArrowUp should wrap to last
      await fireEvent.keyDown(input, { key: "ArrowUp" });

      options = screen.getAllByRole("option");
      expect(options[3]).toHaveAttribute("aria-selected", "true");
    });

    it("Enter selects current option", async () => {
      const onSelect = vi.fn();
      render(BranchDropdown, { props: { ...defaultProps, onSelect } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith("main");
    });

    it("Tab selects current option and moves focus", async () => {
      const onSelect = vi.fn();
      render(BranchDropdown, { props: { ...defaultProps, onSelect } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Tab" });

      expect(onSelect).toHaveBeenCalledWith("main");
      expect(input).toHaveAttribute("aria-expanded", "false");
    });

    it("Escape closes dropdown without selecting", async () => {
      const onSelect = vi.fn();
      render(BranchDropdown, { props: { ...defaultProps, onSelect } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      expect(input).toHaveAttribute("aria-expanded", "true");

      await fireEvent.keyDown(input, { key: "Escape" });

      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Tab selects typed branch when it exactly matches an option", async () => {
      const onSelect = vi.fn();
      render(BranchDropdown, { props: { ...defaultProps, onSelect } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Type exact branch name without using arrow keys
      await fireEvent.input(input, { target: { value: "main" } });

      // Press Tab without navigating with arrows
      await fireEvent.keyDown(input, { key: "Tab" });

      // Should select the typed branch
      expect(onSelect).toHaveBeenCalledWith("main");
    });

    it("Tab does not select when typed text does not match any branch", async () => {
      const onSelect = vi.fn();
      render(BranchDropdown, { props: { ...defaultProps, onSelect } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Type non-matching text
      await fireEvent.input(input, { target: { value: "nonexistent" } });

      // Press Tab
      await fireEvent.keyDown(input, { key: "Tab" });

      // Should NOT call onSelect
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe("selection", () => {
    it("mousedown on option prevents blur and selects branch", async () => {
      const onSelect = vi.fn();
      render(BranchDropdown, { props: { ...defaultProps, onSelect } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const option = screen.getByText("develop");

      // Create mousedown event to verify preventDefault is called
      const mousedownEvent = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(mousedownEvent, "preventDefault");

      option.dispatchEvent(mousedownEvent);

      // Wait for any async effects
      await tick();

      // Verify preventDefault was called (prevents input blur)
      expect(preventDefaultSpy).toHaveBeenCalled();

      // Verify selection occurred
      expect(onSelect).toHaveBeenCalledWith("develop");
    });

    // Note: Selection is handled via onmousedown, not onclick.
    // In real browsers, clicking triggers: mousedown -> blur -> mouseup -> click
    // The blur happens BEFORE click, closing the dropdown before onclick fires.
    // We use onmousedown with preventDefault() to prevent blur and select in one action.
    // fireEvent.click() doesn't replicate this blur-before-click timing issue,
    // so we test with fireEvent.mouseDown() which matches our actual handler.
    it("selecting an option via mousedown works correctly", async () => {
      const onSelect = vi.fn();
      render(BranchDropdown, { props: { ...defaultProps, onSelect } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const option = screen.getByText("develop");
      await fireEvent.mouseDown(option);

      expect(onSelect).toHaveBeenCalledWith("develop");
    });

    it("displays selected value in input", async () => {
      render(BranchDropdown, { props: { ...defaultProps, value: "main" } });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox") as HTMLInputElement;
      expect(input.value).toBe("main");
    });
  });

  describe("positioning", () => {
    it("dropdown uses fixed positioning when open", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const listbox = screen.getByRole("listbox");

      // Verify fixed positioning via inline styles (set by component)
      // Note: JSDOM doesn't apply CSS from <style> blocks, so we verify
      // the inline styles that the component sets for fixed positioning
      expect(listbox.style.top).toBeTruthy();
      expect(listbox.style.left).toBeTruthy();
      expect(listbox.style.width).toBeTruthy();

      // Verify the CSS class is applied (which contains position: fixed)
      expect(listbox.classList.contains("branch-listbox")).toBe(true);
    });

    it("dropdown position updates on window resize", async () => {
      render(BranchDropdown, { props: defaultProps });

      await vi.runAllTimersAsync();

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const listbox = screen.getByRole("listbox");
      const initialTop = listbox.style.top;

      // Mock getBoundingClientRect to simulate position change
      const originalGetBoundingClientRect = input.getBoundingClientRect;
      input.getBoundingClientRect = () => ({
        top: 200,
        left: 50,
        width: 300,
        height: 30,
        right: 350,
        bottom: 230,
        x: 50,
        y: 200,
        toJSON: () => ({}),
      });

      // Trigger resize event
      window.dispatchEvent(new Event("resize"));
      await tick();

      // Position should have been recalculated
      const newTop = listbox.style.top;

      // Restore original
      input.getBoundingClientRect = originalGetBoundingClientRect;

      // The top position should be different after resize
      // (Since we changed getBoundingClientRect to return a different value)
      expect(newTop).not.toBe(initialTop);
    });
  });
});
