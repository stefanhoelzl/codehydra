/**
 * Tests for the FilterableDropdown shared component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import FilterableDropdown from "./FilterableDropdown.svelte";

// Helper to create dropdown options
function createOption(
  label: string,
  value?: string
): { type: "option"; label: string; value: string } {
  return { type: "option", label, value: value ?? label };
}

function createHeader(label: string): { type: "header"; label: string; value: string } {
  return { type: "header", label, value: `__header_${label}__` };
}

// Default filter function - filters by label
function defaultFilter(
  option: { type: "option" | "header"; label: string; value: string },
  filterLowercase: string
): boolean {
  return option.type === "header" || option.label.toLowerCase().includes(filterLowercase);
}

describe("FilterableDropdown component", () => {
  const defaultOptions = [createOption("Apple"), createOption("Banana"), createOption("Cherry")];

  const defaultProps = {
    options: defaultOptions,
    value: "",
    onSelect: vi.fn(),
    filterOption: defaultFilter,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  describe("rendering", () => {
    it("renders all options when opened", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      expect(screen.getByText("Apple")).toBeInTheDocument();
      expect(screen.getByText("Banana")).toBeInTheDocument();
      expect(screen.getByText("Cherry")).toBeInTheDocument();
    });

    it("renders combobox with correct ARIA attributes", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(input).toHaveAttribute("aria-haspopup", "listbox");
      expect(input).toHaveAttribute("aria-autocomplete", "list");
    });

    it("aria-expanded reflects dropdown open state", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("aria-expanded", "false");

      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "true");
    });

    it("listbox has correct role and is controlled by combobox", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const listbox = screen.getByRole("listbox");
      expect(listbox).toBeInTheDocument();

      const controlsId = input.getAttribute("aria-controls");
      expect(controlsId).toBeTruthy();
      expect(listbox).toHaveAttribute("id", controlsId);
    });

    it("options have correct role", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(3);
    });

    it("displays placeholder when no value", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, placeholder: "Select item..." } });

      const input = screen.getByRole("combobox") as HTMLInputElement;
      expect(input).toHaveAttribute("placeholder", "Select item...");
    });
  });

  describe("filtering", () => {
    it("shows all options when opened with pre-selected value", async () => {
      // Regression test: When value="Apple" is pre-selected, all options should show
      // not just ones containing "Apple". The selected value should only affect display,
      // not filtering.
      render(FilterableDropdown, { props: { ...defaultProps, value: "Apple" } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // ALL options should be visible, not just Apple
      expect(screen.getByText("Apple")).toBeInTheDocument();
      expect(screen.getByText("Banana")).toBeInTheDocument();
      expect(screen.getByText("Cherry")).toBeInTheDocument();
    });

    it("allows filtering after opening with pre-selected value", async () => {
      // Edge case: Verify that filtering works correctly after dropdown opens with
      // a pre-selected value. This tests the displayText/filterText separation.
      render(FilterableDropdown, { props: { ...defaultProps, value: "Apple" } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // All options should be visible initially
      expect(screen.getByText("Apple")).toBeInTheDocument();
      expect(screen.getByText("Banana")).toBeInTheDocument();
      expect(screen.getByText("Cherry")).toBeInTheDocument();

      // Type to filter
      await fireEvent.input(input, { target: { value: "Ban" } });

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      // Only Banana should be visible - filtering works after pre-selection
      expect(screen.queryByText("Apple")).not.toBeInTheDocument();
      expect(screen.getByText("Banana")).toBeInTheDocument();
      expect(screen.queryByText("Cherry")).not.toBeInTheDocument();
    });

    it("filters options using callback", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "app" } });

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      expect(screen.getByText("Apple")).toBeInTheDocument();
      expect(screen.queryByText("Banana")).not.toBeInTheDocument();
      expect(screen.queryByText("Cherry")).not.toBeInTheDocument();
    });

    it("empty filter shows all options", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Type something, then clear
      await fireEvent.input(input, { target: { value: "app" } });
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      await fireEvent.input(input, { target: { value: "" } });
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      expect(screen.getByText("Apple")).toBeInTheDocument();
      expect(screen.getByText("Banana")).toBeInTheDocument();
      expect(screen.getByText("Cherry")).toBeInTheDocument();
    });

    it("debounces filter input with 200ms delay", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "ban" } });

      // Immediately after typing, all options still visible
      expect(screen.getByText("Apple")).toBeInTheDocument();

      // Wait 100ms - still not filtered
      await vi.advanceTimersByTimeAsync(100);
      await tick();
      expect(screen.getByText("Apple")).toBeInTheDocument();

      // Wait past debounce threshold
      await vi.advanceTimersByTimeAsync(150);
      await tick();

      // Now filtered
      expect(screen.queryByText("Apple")).not.toBeInTheDocument();
      expect(screen.getByText("Banana")).toBeInTheDocument();
    });

    it("respects custom debounceMs prop", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, debounceMs: 500 } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "ban" } });

      // Wait 300ms - still not filtered
      await vi.advanceTimersByTimeAsync(300);
      await tick();
      expect(screen.getByText("Apple")).toBeInTheDocument();

      // Wait past 500ms threshold
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      expect(screen.queryByText("Apple")).not.toBeInTheDocument();
      expect(screen.getByText("Banana")).toBeInTheDocument();
    });

    it("auto-opens dropdown when typing produces matches with openOnFocus=false", async () => {
      // When openOnFocus is false (like NameBranchDropdown), the dropdown should
      // still open when typing produces matches
      render(FilterableDropdown, { props: { ...defaultProps, openOnFocus: false } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Dropdown should NOT open on focus because openOnFocus=false
      expect(input).toHaveAttribute("aria-expanded", "false");

      // Type something that matches
      await fireEvent.input(input, { target: { value: "app" } });

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      // Dropdown should now be open because there are matches
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Apple")).toBeInTheDocument();
    });

    it("does not auto-open dropdown when typing produces no matches", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, openOnFocus: false } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Type something that doesn't match
      await fireEvent.input(input, { target: { value: "xyz" } });

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(250);
      await tick();

      // Dropdown should stay closed because there are no matches
      expect(input).toHaveAttribute("aria-expanded", "false");
    });
  });

  describe("keyboard navigation", () => {
    it("Arrow Down moves to next option", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Arrow Up moves to previous option", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "ArrowUp" });

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Arrow Down at last option wraps to first", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Navigate to last option
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      const options = screen.getAllByRole("option");
      expect(options[2]).toHaveAttribute("aria-selected", "true");

      // One more ArrowDown wraps to first
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Arrow Up at first option wraps to last", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      await fireEvent.keyDown(input, { key: "ArrowDown" });
      // Now at first option, go up
      await fireEvent.keyDown(input, { key: "ArrowUp" });

      const options = screen.getAllByRole("option");
      expect(options[2]).toHaveAttribute("aria-selected", "true");
    });

    it("Arrow Down skips header options", async () => {
      const optionsWithHeaders = [
        createHeader("Fruits"),
        createOption("Apple"),
        createOption("Banana"),
        createHeader("Vegetables"),
        createOption("Carrot"),
      ];

      render(FilterableDropdown, { props: { ...defaultProps, options: optionsWithHeaders } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      // First selectable should be Apple (skips Fruits header)
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
      expect(options[0]).toHaveTextContent("Apple");
    });

    it("Enter selects highlighted option", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith("Apple");
    });

    it("Tab selects highlighted option", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Tab" });

      expect(onSelect).toHaveBeenCalledWith("Apple");
    });

    it("Tab selects exact match when no navigation", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "Apple" } });
      await fireEvent.keyDown(input, { key: "Tab" });

      expect(onSelect).toHaveBeenCalledWith("Apple");
    });

    it("Tab does not select when no match and no navigation", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "nonexistent" } });
      await fireEvent.keyDown(input, { key: "Tab" });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Escape closes dropdown without selecting", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "true");

      await fireEvent.keyDown(input, { key: "Escape" });

      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Escape when dropdown open stops immediate propagation", async () => {
      // When dropdown is open, ESC should close it and stop propagation
      // This prevents parent dialogs from also closing
      // We verify this by checking stopImmediatePropagation was called
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "true");

      // Create a custom event that we can spy on
      const keyDownEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      const stopPropagationSpy = vi.spyOn(keyDownEvent, "stopPropagation");

      input.dispatchEvent(keyDownEvent);
      await tick();

      // Verify stopPropagation was called (preventing parent handlers)
      expect(stopPropagationSpy).toHaveBeenCalled();
      // Dropdown should be closed
      expect(input).toHaveAttribute("aria-expanded", "false");
    });

    it("Escape when dropdown closed does not stop propagation", async () => {
      // When dropdown is already closed, ESC should propagate to parent
      // so that parent dialog can close
      render(FilterableDropdown, { props: { ...defaultProps, openOnFocus: false } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "false");

      const keyDownEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      const stopPropagationSpy = vi.spyOn(keyDownEvent, "stopPropagation");

      input.dispatchEvent(keyDownEvent);
      await tick();

      // Verify stopPropagation was NOT called (allowing event to bubble to dialog)
      expect(stopPropagationSpy).not.toHaveBeenCalled();
    });

    it("aria-activedescendant updates on navigation", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Initial - no active descendant
      expect(input.getAttribute("aria-activedescendant")).toBeFalsy();

      await fireEvent.keyDown(input, { key: "ArrowDown" });

      const activeId = input.getAttribute("aria-activedescendant");
      expect(activeId).toBeTruthy();
    });

    it("Arrow Down calls scrollIntoView on highlighted option", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Get the first option and spy on scrollIntoView
      const options = screen.getAllByRole("option");
      const scrollSpy = vi.fn();
      options[0]!.scrollIntoView = scrollSpy;

      await fireEvent.keyDown(input, { key: "ArrowDown" });

      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    });

    it("Arrow Up calls scrollIntoView on highlighted option", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Navigate down first, then up
      await fireEvent.keyDown(input, { key: "ArrowDown" });

      // Get the last option (wrap around) and spy on scrollIntoView
      const options = screen.getAllByRole("option");
      const scrollSpy = vi.fn();
      options[2]!.scrollIntoView = scrollSpy;

      await fireEvent.keyDown(input, { key: "ArrowUp" });

      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    });
  });

  describe("selection", () => {
    it("calls onSelect with option value", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const option = screen.getByText("Banana");
      await fireEvent.mouseDown(option);

      expect(onSelect).toHaveBeenCalledWith("Banana");
    });

    it("mousedown prevents blur and selects", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const option = screen.getByText("Cherry");
      const mousedownEvent = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(mousedownEvent, "preventDefault");

      option.dispatchEvent(mousedownEvent);
      await tick();

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(onSelect).toHaveBeenCalledWith("Cherry");
    });

    it("displays current value in input", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, value: "Banana" } });

      const input = screen.getByRole("combobox") as HTMLInputElement;
      expect(input.value).toBe("Banana");
    });

    it("closes dropdown after selection", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "true");

      const option = screen.getByText("Apple");
      await fireEvent.mouseDown(option);

      expect(input).toHaveAttribute("aria-expanded", "false");
    });
  });

  describe("disabled state", () => {
    it("disabled prop prevents interaction", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, disabled: true } });

      const input = screen.getByRole("combobox");
      expect(input).toBeDisabled();

      await fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "false");
    });

    it("disabled prevents keyboard navigation", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, disabled: true, onSelect } });

      const input = screen.getByRole("combobox");
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe("positioning", () => {
    it("dropdown uses fixed positioning with inline styles", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const listbox = screen.getByRole("listbox");
      expect(listbox.style.top).toBeTruthy();
      expect(listbox.style.left).toBeTruthy();
      expect(listbox.style.width).toBeTruthy();
    });

    it("position recalculates on window resize", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      const listbox = screen.getByRole("listbox");
      const initialTop = listbox.style.top;

      // Mock getBoundingClientRect
      const originalGetBoundingClientRect = input.getBoundingClientRect;
      input.getBoundingClientRect = () => ({
        top: 300,
        left: 100,
        width: 250,
        height: 30,
        right: 350,
        bottom: 330,
        x: 100,
        y: 300,
        toJSON: () => ({}),
      });

      window.dispatchEvent(new Event("resize"));
      await tick();

      const newTop = listbox.style.top;
      input.getBoundingClientRect = originalGetBoundingClientRect;

      expect(newTop).not.toBe(initialTop);
    });
  });

  describe("dynamic options", () => {
    it("handles options prop change while open", async () => {
      const { rerender } = render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      expect(screen.getByText("Apple")).toBeInTheDocument();
      expect(screen.queryByText("Orange")).not.toBeInTheDocument();

      // Update options
      await rerender({
        ...defaultProps,
        options: [createOption("Orange"), createOption("Grape")],
      });

      expect(screen.queryByText("Apple")).not.toBeInTheDocument();
      expect(screen.getByText("Orange")).toBeInTheDocument();
      expect(screen.getByText("Grape")).toBeInTheDocument();
    });
  });

  describe("header options", () => {
    it("renders headers with presentation role", async () => {
      const optionsWithHeaders = [
        createHeader("Fruits"),
        createOption("Apple"),
        createHeader("Vegetables"),
        createOption("Carrot"),
      ];

      render(FilterableDropdown, { props: { ...defaultProps, options: optionsWithHeaders } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);

      // Headers should have presentation role (not option)
      const headers = screen.getAllByRole("presentation");
      expect(headers.length).toBeGreaterThan(0);

      // Options should still have option role
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(2);
    });
  });

  describe("allowFreeText", () => {
    it("Enter with no selection does nothing when allowFreeText is false", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect, allowFreeText: false } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "custom-value" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Enter with no selection calls onSelect with typed text when allowFreeText is true", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect, allowFreeText: true } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "my-custom-branch" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith("my-custom-branch");
    });

    it("Enter with highlighted option still selects option when allowFreeText is true", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect, allowFreeText: true } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith("Apple");
    });

    it("Enter with empty text does nothing when allowFreeText is true", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect, allowFreeText: true } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "   " } }); // whitespace only
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("trims whitespace from free text input", async () => {
      const onSelect = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onSelect, allowFreeText: true } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "  my-branch  " } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onSelect).toHaveBeenCalledWith("my-branch");
    });

    it("reverts to prop value on blur when allowFreeText is false and no valid match", async () => {
      render(FilterableDropdown, {
        props: { ...defaultProps, value: "Banana", allowFreeText: false },
      });

      const input = screen.getByRole("combobox") as HTMLInputElement;

      await fireEvent.focus(input);

      // Type invalid text
      await fireEvent.input(input, { target: { value: "invalid-option" } });
      expect(input.value).toBe("invalid-option");

      // Blur should revert to original value
      await fireEvent.blur(input);

      expect(input.value).toBe("Banana");
    });

    it("keeps valid match on blur when allowFreeText is false", async () => {
      render(FilterableDropdown, {
        props: { ...defaultProps, value: "Banana", allowFreeText: false },
      });

      const input = screen.getByRole("combobox") as HTMLInputElement;

      await fireEvent.focus(input);

      // Type valid option label (case-insensitive match)
      await fireEvent.input(input, { target: { value: "apple" } });
      expect(input.value).toBe("apple");

      // Blur should keep the valid value
      await fireEvent.blur(input);

      expect(input.value).toBe("apple");
    });

    it("does not revert on blur when allowFreeText is true", async () => {
      render(FilterableDropdown, {
        props: { ...defaultProps, value: "Banana", allowFreeText: true },
      });

      const input = screen.getByRole("combobox") as HTMLInputElement;

      await fireEvent.focus(input);

      // Type anything
      await fireEvent.input(input, { target: { value: "custom-text" } });

      // Blur should keep the custom text (free text allowed)
      await fireEvent.blur(input);

      expect(input.value).toBe("custom-text");
    });
  });

  describe("id attribute", () => {
    it("sets id on input element when id prop is provided", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, id: "my-dropdown" } });

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("id", "my-dropdown-input");
    });

    it("does not set id on input when id prop is not provided", async () => {
      render(FilterableDropdown, { props: defaultProps });

      const input = screen.getByRole("combobox");
      expect(input).not.toHaveAttribute("id");
    });
  });

  describe("onEnter callback", () => {
    it("does not call onEnter when selecting option with Enter", async () => {
      // Selecting an existing option should not trigger onEnter
      // (user can still click the Submit button manually)
      const onEnter = vi.fn();
      render(FilterableDropdown, { props: { ...defaultProps, onEnter } });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onEnter).not.toHaveBeenCalled();
    });

    it("calls onEnter after free text selection with Enter", async () => {
      // Free text + Enter = confirm custom value and trigger onEnter
      const onEnter = vi.fn();
      render(FilterableDropdown, {
        props: { ...defaultProps, onEnter, allowFreeText: true },
      });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "custom-value" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onEnter).toHaveBeenCalledTimes(1);
    });

    it("does not call onEnter when allowFreeText is false", async () => {
      // No free text allowed = Enter does nothing, no onEnter
      const onEnter = vi.fn();
      render(FilterableDropdown, {
        props: { ...defaultProps, onEnter, allowFreeText: false },
      });

      const input = screen.getByRole("combobox");
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "custom-value" } });
      await fireEvent.keyDown(input, { key: "Enter" });

      expect(onEnter).not.toHaveBeenCalled();
    });
  });

  describe("autofocus", () => {
    it("sets data-autofocus attribute when autofocus is true", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, autofocus: true } });

      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("data-autofocus");
    });

    it("does not set data-autofocus attribute when autofocus is false", async () => {
      render(FilterableDropdown, { props: { ...defaultProps, autofocus: false } });

      const input = screen.getByRole("combobox");
      expect(input).not.toHaveAttribute("data-autofocus");
    });
  });
});
