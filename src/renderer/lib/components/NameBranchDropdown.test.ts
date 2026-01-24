/**
 * Tests for the NameBranchDropdown component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import type { BaseInfo, ProjectId } from "@shared/api/types";

// Create mock functions with vi.hoisted - required for vitest mocking pattern
const { mockFetchBases } = vi.hoisted(() => ({
  mockFetchBases: vi.fn(),
}));

// Mock $lib/api - must be a static mock, not dynamic (no importOriginal)
vi.mock("$lib/api", () => ({
  projects: {
    fetchBases: mockFetchBases,
  },
}));

// Import component after mocks
import NameBranchDropdown, { type NameBranchSelection } from "./NameBranchDropdown.svelte";

describe("NameBranchDropdown component", () => {
  const testProjectId = "test-project-12345678" as ProjectId;

  const defaultProps = {
    projectId: testProjectId,
    value: "",
    onSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /**
   * Helper to set up mock branches and render component
   */
  async function renderWithBranches(
    branches: BaseInfo[],
    props: Partial<
      typeof defaultProps & {
        id?: string;
        onEnter?: () => void;
        openOnFocus?: boolean;
        autofocus?: boolean;
      }
    > = {}
  ): Promise<void> {
    mockFetchBases.mockResolvedValue({ bases: branches });
    render(NameBranchDropdown, { props: { ...defaultProps, ...props } });
    // Wait for promise to resolve
    await vi.advanceTimersByTimeAsync(0);
    await tick();
  }

  /**
   * Helper to focus input and open dropdown.
   * NameBranchDropdown has openOnFocus=false by default, so we need ArrowDown.
   */
  async function focusAndOpenDropdown(input: HTMLElement): Promise<void> {
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: "ArrowDown" });
  }

  // UI Test #3: Name dropdown shows local branches without worktrees
  describe("UI-state: shows local branches without worktrees", () => {
    it("shows local branches with derives set (no worktree)", async () => {
      const branches: BaseInfo[] = [
        { name: "main", isRemote: false }, // No derives - has worktree
        { name: "feature-auth", isRemote: false, derives: "feature-auth" }, // Has derives - no worktree
        { name: "feature-login", isRemote: false, derives: "feature-login" }, // Has derives - no worktree
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      // Should show branches with derives
      expect(screen.getByText("feature-auth")).toBeInTheDocument();
      expect(screen.getByText("feature-login")).toBeInTheDocument();

      // Should NOT show branch without derives (main has worktree)
      const options = screen.getAllByRole("option");
      const optionTexts = options.map((o) => o.textContent);
      expect(optionTexts).not.toContain("main");
    });

    it("shows LOCAL BRANCHES header when local branches with derives exist", async () => {
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      expect(screen.getByText("Local Branches")).toBeInTheDocument();
    });

    it("hides LOCAL BRANCHES header when no local branches have derives", async () => {
      const branches: BaseInfo[] = [
        { name: "main", isRemote: false }, // No derives
        { name: "origin/feature-x", isRemote: true, derives: "feature-x" },
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      expect(screen.queryByText("Local Branches")).not.toBeInTheDocument();
    });
  });

  // UI Test #4: Name dropdown shows remote branches without local
  describe("UI-state: shows remote branches without local counterpart", () => {
    it("shows remote branches with derives set (no local counterpart)", async () => {
      const branches: BaseInfo[] = [
        { name: "origin/main", isRemote: true }, // No derives - has local counterpart
        { name: "origin/feature-payments", isRemote: true, derives: "feature-payments" },
        { name: "origin/feature-dashboard", isRemote: true, derives: "feature-dashboard" },
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      // Should show branches with derives (displayed without remote prefix)
      expect(screen.getByText("feature-payments")).toBeInTheDocument();
      expect(screen.getByText("feature-dashboard")).toBeInTheDocument();

      // Should NOT show branch without derives
      const options = screen.getAllByRole("option");
      const optionTexts = options.map((o) => o.textContent);
      expect(optionTexts).not.toContain("origin/main");
      expect(optionTexts).not.toContain("main");
    });

    it("shows REMOTE BRANCHES header when remote branches with derives exist", async () => {
      const branches: BaseInfo[] = [
        { name: "origin/feature-x", isRemote: true, derives: "feature-x" },
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      expect(screen.getByText("Remote Branches")).toBeInTheDocument();
    });

    it("hides REMOTE BRANCHES header when no remote branches have derives", async () => {
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
        { name: "origin/main", isRemote: true }, // No derives
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      expect(screen.queryByText("Remote Branches")).not.toBeInTheDocument();
    });
  });

  // UI Test #5: Selecting branch auto-fills base
  describe("selecting branch auto-fills base", () => {
    it("onSelect receives suggestedBase when branch has base field", async () => {
      const onSelect = vi.fn();
      const branches: BaseInfo[] = [
        {
          name: "feature-auth",
          isRemote: false,
          derives: "feature-auth",
          base: "origin/feature-auth",
        },
      ];

      await renderWithBranches(branches, { onSelect });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      const option = screen.getByText("feature-auth");
      await fireEvent.mouseDown(option);

      expect(onSelect).toHaveBeenCalledWith({
        name: "feature-auth",
        suggestedBase: "origin/feature-auth",
        isExistingBranch: true,
      });
    });

    it("onSelect receives remote branch base when selecting remote", async () => {
      const onSelect = vi.fn();
      const branches: BaseInfo[] = [
        {
          name: "origin/feature-payments",
          isRemote: true,
          derives: "feature-payments",
          base: "origin/feature-payments",
        },
      ];

      await renderWithBranches(branches, { onSelect });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      const option = screen.getByText("feature-payments");
      await fireEvent.mouseDown(option);

      expect(onSelect).toHaveBeenCalledWith({
        name: "feature-payments",
        suggestedBase: "origin/feature-payments",
        isExistingBranch: true,
      });
    });

    it("onSelect omits suggestedBase when branch has no base field", async () => {
      const onSelect = vi.fn();
      const branches: BaseInfo[] = [
        { name: "feature-x", isRemote: false, derives: "feature-x" }, // No base field
      ];

      await renderWithBranches(branches, { onSelect });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      const option = screen.getByText("feature-x");
      await fireEvent.mouseDown(option);

      expect(onSelect).toHaveBeenCalledWith({
        name: "feature-x",
        isExistingBranch: true,
      });
      // Verify suggestedBase is not in the call
      const callArg = onSelect.mock.calls[0]![0] as NameBranchSelection;
      expect(callArg.suggestedBase).toBeUndefined();
    });
  });

  // UI Test #6: Custom name entry works
  describe("custom name entry", () => {
    it("typing custom name and pressing Enter emits with isExistingBranch: false", async () => {
      const onSelect = vi.fn();
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
      ];

      await renderWithBranches(branches, { onSelect });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);
      await fireEvent.input(input, { target: { value: "my-new-feature" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith({
        name: "my-new-feature",
        isExistingBranch: false,
      });
    });

    it("custom name entry does not include suggestedBase", async () => {
      const onSelect = vi.fn();
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth", base: "main" },
      ];

      await renderWithBranches(branches, { onSelect });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);
      await fireEvent.input(input, { target: { value: "custom-branch" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      const callArg = onSelect.mock.calls[0]![0] as NameBranchSelection;
      expect(callArg.isExistingBranch).toBe(false);
      expect(callArg.suggestedBase).toBeUndefined();
    });

    it("pressing Enter with highlighted option selects that option", async () => {
      const onSelect = vi.fn();
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth", base: "main" },
      ];

      await renderWithBranches(branches, { onSelect });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" }); // Highlight first option
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith({
        name: "feature-auth",
        suggestedBase: "main",
        isExistingBranch: true,
      });
    });
  });

  describe("error states", () => {
    it("shows error message when fetch fails", async () => {
      mockFetchBases.mockRejectedValue(new Error("Network error"));
      render(NameBranchDropdown, { props: defaultProps });

      await vi.advanceTimersByTimeAsync(0);
      await tick();

      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  describe("filtering", () => {
    it("filters branches by derives value (label)", async () => {
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
        { name: "feature-login", isRemote: false, derives: "feature-login" },
        { name: "origin/feature-payment", isRemote: true, derives: "feature-payment" },
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      // Type to filter
      await fireEvent.input(input, { target: { value: "auth" } });
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      expect(screen.getByText("feature-auth")).toBeInTheDocument();
      expect(screen.queryByText("feature-login")).not.toBeInTheDocument();
      expect(screen.queryByText("feature-payment")).not.toBeInTheDocument();
    });

    it("hides headers when no matching branches in group", async () => {
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
        { name: "origin/bugfix-payment", isRemote: true, derives: "bugfix-payment" },
      ];

      await renderWithBranches(branches);

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);

      // Filter to only match remote
      await fireEvent.input(input, { target: { value: "bugfix" } });
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      // Local header should be hidden (no local matches)
      expect(screen.queryByText("Local Branches")).not.toBeInTheDocument();
      // Remote header should be visible
      expect(screen.getByText("Remote Branches")).toBeInTheDocument();
    });
  });

  describe("id prop", () => {
    it("forwards id prop to FilterableDropdown input", async () => {
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
      ];

      mockFetchBases.mockResolvedValue({ bases: branches });
      render(NameBranchDropdown, { props: { ...defaultProps, id: "workspace-name" } });
      await vi.advanceTimersByTimeAsync(0);
      await tick();

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("id", "workspace-name-input");
    });
  });

  describe("onEnter callback", () => {
    it("calls onEnter when Enter is pressed", async () => {
      const onEnter = vi.fn();
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
      ];

      await renderWithBranches(branches, { onEnter });

      const input = screen.getByRole("combobox");
      await focusAndOpenDropdown(input);
      await fireEvent.input(input, { target: { value: "my-branch" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onEnter).toHaveBeenCalledTimes(1);
    });
  });

  describe("autofocus prop", () => {
    it("sets data-autofocus attribute when autofocus is true", async () => {
      const branches: BaseInfo[] = [
        { name: "feature-auth", isRemote: false, derives: "feature-auth" },
      ];

      await renderWithBranches(branches, { autofocus: true });

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("data-autofocus");
    });
  });
});
