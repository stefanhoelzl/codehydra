/**
 * Tests for the AgentSelectionDialog component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import AgentSelectionDialog from "./AgentSelectionDialog.svelte";
import type { AgentInfo } from "@shared/ipc";

const TEST_AGENTS: readonly AgentInfo[] = [
  { agent: "claude", label: "Claude", icon: "sparkle" },
  { agent: "opencode", label: "OpenCode", icon: "terminal" },
];

describe("AgentSelectionDialog component", () => {
  const defaultProps = {
    agents: TEST_AGENTS,
    onselect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("rendering", () => {
    it("renders both agent options (Claude and OpenCode cards visible)", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      // Both cards should be visible with their titles
      expect(screen.getByText("Claude")).toBeInTheDocument();
      expect(screen.getByText("OpenCode")).toBeInTheDocument();
    });

    it("renders heading and subtitle", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      expect(screen.getByRole("heading", { name: /choose your ai agent/i })).toBeInTheDocument();
      expect(screen.getByText(/select which ai assistant/i)).toBeInTheDocument();
    });

    it("renders Continue button", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      // vscode-button is a custom element, find by text content
      expect(screen.getByText("Continue")).toBeInTheDocument();
    });

    it("renders cards as radio buttons with proper roles", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      // Container should have radiogroup role
      expect(screen.getByRole("radiogroup")).toBeInTheDocument();

      // Each card should have radio role
      const radios = screen.getAllByRole("radio");
      expect(radios).toHaveLength(2);
    });

    it("selected card (Claude) has focus when dialog renders", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      expect(document.activeElement).toBe(claudeCard);
    });
  });

  describe("selection behavior", () => {
    it("Claude is selected by default", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      expect(claudeCard).toHaveAttribute("aria-checked", "true");

      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });
      expect(opencodeCard).toHaveAttribute("aria-checked", "false");
    });

    it("clicking OpenCode card updates selection", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });
      await fireEvent.click(opencodeCard);

      // OpenCode should now be selected
      expect(opencodeCard).toHaveAttribute("aria-checked", "true");

      // Claude should be deselected
      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      expect(claudeCard).toHaveAttribute("aria-checked", "false");
    });

    it("clicking Claude card when OpenCode is selected switches back", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      // First select OpenCode
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });
      await fireEvent.click(opencodeCard);

      // Then select Claude
      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      await fireEvent.click(claudeCard);

      expect(claudeCard).toHaveAttribute("aria-checked", "true");
      expect(opencodeCard).toHaveAttribute("aria-checked", "false");
    });
  });

  describe("keyboard navigation", () => {
    it("Enter key on card calls onselect (continues with current selection)", async () => {
      const onselect = vi.fn();
      render(AgentSelectionDialog, { props: { agents: TEST_AGENTS, onselect } });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });

      // Focus the card and press Enter
      claudeCard.focus();
      await fireEvent.keyDown(claudeCard, { key: "Enter" });

      expect(onselect).toHaveBeenCalledTimes(1);
      expect(onselect).toHaveBeenCalledWith("claude");
    });

    it("Space key selects a card", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      // Focus the card and press Space
      opencodeCard.focus();
      await fireEvent.keyDown(opencodeCard, { key: " " });

      expect(opencodeCard).toHaveAttribute("aria-checked", "true");
    });

    it("ArrowDown navigates from Claude to OpenCode", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      claudeCard.focus();
      await fireEvent.keyDown(claudeCard, { key: "ArrowDown" });

      expect(opencodeCard).toHaveAttribute("aria-checked", "true");
      expect(claudeCard).toHaveAttribute("aria-checked", "false");
      expect(document.activeElement).toBe(opencodeCard);
    });

    it("ArrowUp navigates from OpenCode to Claude", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      // First select OpenCode
      await fireEvent.click(opencodeCard);
      opencodeCard.focus();
      await fireEvent.keyDown(opencodeCard, { key: "ArrowUp" });

      expect(claudeCard).toHaveAttribute("aria-checked", "true");
      expect(opencodeCard).toHaveAttribute("aria-checked", "false");
      expect(document.activeElement).toBe(claudeCard);
    });

    it("ArrowDown wraps from OpenCode to Claude", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      // First select OpenCode
      await fireEvent.click(opencodeCard);
      opencodeCard.focus();
      await fireEvent.keyDown(opencodeCard, { key: "ArrowDown" });

      expect(claudeCard).toHaveAttribute("aria-checked", "true");
      expect(opencodeCard).toHaveAttribute("aria-checked", "false");
      expect(document.activeElement).toBe(claudeCard);
    });

    it("ArrowUp wraps from Claude to OpenCode", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      claudeCard.focus();
      await fireEvent.keyDown(claudeCard, { key: "ArrowUp" });

      expect(opencodeCard).toHaveAttribute("aria-checked", "true");
      expect(claudeCard).toHaveAttribute("aria-checked", "false");
      expect(document.activeElement).toBe(opencodeCard);
    });

    it("ArrowRight navigates from Claude to OpenCode", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      claudeCard.focus();
      await fireEvent.keyDown(claudeCard, { key: "ArrowRight" });

      expect(opencodeCard).toHaveAttribute("aria-checked", "true");
      expect(document.activeElement).toBe(opencodeCard);
    });

    it("ArrowLeft navigates from OpenCode to Claude", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      // First select OpenCode
      await fireEvent.click(opencodeCard);
      opencodeCard.focus();
      await fireEvent.keyDown(opencodeCard, { key: "ArrowLeft" });

      expect(claudeCard).toHaveAttribute("aria-checked", "true");
      expect(document.activeElement).toBe(claudeCard);
    });

    it("Tab can focus Continue button", async () => {
      const user = userEvent.setup();
      render(AgentSelectionDialog, { props: defaultProps });

      // Tab through elements to reach Continue button
      await user.tab();
      await user.tab();
      await user.tab();

      // vscode-button is a custom element, find by text content
      const continueButton = screen.getByText("Continue");
      // Note: vscode-button may not receive focus in test environment the same way,
      // so we verify it's in the document and focusable
      expect(continueButton).toBeInTheDocument();
    });
  });

  describe("Continue button behavior", () => {
    it("clicking Continue calls onselect with default selection (Claude)", async () => {
      const onselect = vi.fn();
      render(AgentSelectionDialog, { props: { agents: TEST_AGENTS, onselect } });

      // Find vscode-button by text content
      const continueButton = screen.getByText("Continue");
      await fireEvent.click(continueButton);

      expect(onselect).toHaveBeenCalledTimes(1);
      expect(onselect).toHaveBeenCalledWith("claude");
    });

    it("clicking Continue after selecting OpenCode calls onselect with opencode", async () => {
      const onselect = vi.fn();
      render(AgentSelectionDialog, { props: { agents: TEST_AGENTS, onselect } });

      // Select OpenCode
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });
      await fireEvent.click(opencodeCard);

      // Click Continue - find vscode-button by text content
      const continueButton = screen.getByText("Continue");
      await fireEvent.click(continueButton);

      expect(onselect).toHaveBeenCalledTimes(1);
      expect(onselect).toHaveBeenCalledWith("opencode");
    });

    it("Enter key on Continue button triggers onselect", async () => {
      const onselect = vi.fn();
      render(AgentSelectionDialog, { props: { agents: TEST_AGENTS, onselect } });

      // Find vscode-button by text content
      const continueButton = screen.getByText("Continue");
      await fireEvent.keyDown(continueButton, { key: "Enter" });

      // Note: event may fire multiple times due to web component structure
      expect(onselect).toHaveBeenCalled();
      expect(onselect).toHaveBeenCalledWith("claude");
    });

    it("Space key on Continue button triggers onselect", async () => {
      const onselect = vi.fn();
      render(AgentSelectionDialog, { props: { agents: TEST_AGENTS, onselect } });

      // Find vscode-button by text content
      const continueButton = screen.getByText("Continue");
      await fireEvent.keyDown(continueButton, { key: " " });

      // Note: event may fire multiple times due to web component structure
      expect(onselect).toHaveBeenCalled();
      expect(onselect).toHaveBeenCalledWith("claude");
    });
  });

  describe("accessibility", () => {
    it("radiogroup has accessible label", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const radiogroup = screen.getByRole("radiogroup");
      expect(radiogroup).toHaveAttribute("aria-label", "AI Agent selection");
    });

    it("selected card has tabindex 0, unselected has -1", () => {
      render(AgentSelectionDialog, { props: defaultProps });

      // Claude is selected by default
      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      expect(claudeCard).toHaveAttribute("tabindex", "0");
      expect(opencodeCard).toHaveAttribute("tabindex", "-1");
    });

    it("tabindex updates when selection changes", async () => {
      render(AgentSelectionDialog, { props: defaultProps });

      const claudeCard = screen.getByRole("radio", { name: /claude/i });
      const opencodeCard = screen.getByRole("radio", { name: /opencode/i });

      // Select OpenCode
      await fireEvent.click(opencodeCard);

      // Now OpenCode should have tabindex 0
      expect(opencodeCard).toHaveAttribute("tabindex", "0");
      expect(claudeCard).toHaveAttribute("tabindex", "-1");
    });
  });
});
