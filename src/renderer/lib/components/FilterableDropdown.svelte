<script lang="ts">
  /**
   * A dropdown option that can be selected.
   */
  export interface DropdownOption {
    type: "option" | "header";
    label: string;
    value: string;
  }

  interface FilterableDropdownProps {
    options: DropdownOption[];
    value: string;
    onSelect: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
    id?: string;
    /** If true, pressing Enter with no selection calls onSelect with typed text */
    allowFreeText?: boolean;
    /** Called when Enter is pressed with no highlighted option (after any free-text/exact-match commit) */
    onEnter?: (() => void) | undefined;
    /** Called on every input change with the current text */
    onInput?: ((value: string) => void) | undefined;
    /** Whether to focus the input on mount */
    autofocus?: boolean;
    /** Render the input as invalid (red border), e.g. for a validation error */
    invalid?: boolean;
    /** id of the element describing this input (e.g. a validation error) */
    describedBy?: string | undefined;
    /**
     * When false, the input is read-only and the control behaves like a
     * classic select: focus/click opens the list, arrow keys + click pick,
     * typing does nothing. Defaults to true (type-to-filter combobox).
     */
    searchable?: boolean;
  }

  let {
    options,
    value,
    onSelect,
    disabled = false,
    placeholder = "",
    id,
    allowFreeText = false,
    onEnter,
    onInput: onInputCallback,
    autofocus = false,
    invalid = false,
    describedBy = undefined,
    searchable = true,
  }: FilterableDropdownProps = $props();

  // Internal state
  let isOpen = $state(false);
  let highlightedIndex = $state(-1);
  // Track whether user is actively typing (vs selection just happened)
  let isTyping = $state(false);

  // Positioning state for fixed dropdown
  let inputRef: HTMLInputElement | undefined = $state(undefined);
  let dropdownPosition = $state<{ top: number; left: number; width: number } | null>(null);

  // Track local filter text separately from prop value
  // displayText: shown in input field (selected value or user's typed text)
  // filterText: used for filtering options (only user's typed text, empty shows all)
  let localFilterOverride = $state<string | null>(null);
  const displayText = $derived(localFilterOverride ?? value);
  const filterText = $derived(localFilterOverride ?? "");

  // Track previous value to detect external changes (e.g., parent clears selection)
  // This allows us to reset localFilterOverride only when value actually changes,
  // not when user is actively typing/filtering
  let previousValue: string | undefined;

  // Reset localFilterOverride when value prop changes externally
  $effect(() => {
    // On first run, just capture the initial value
    if (previousValue === undefined) {
      previousValue = value;
      return;
    }

    // If value changed, reset local override so displayText uses the new prop value
    if (value !== previousValue) {
      previousValue = value;
      // Free-text parents echo the typed text back through `value` — that
      // echo must not clear the active filter mid-typing. A pick (isTyping
      // false) or a genuinely external value still resets.
      const isTypingEcho = isTyping && value === localFilterOverride;
      if (!isTypingEcho) {
        localFilterOverride = null;
      }
    }
  });

  // IDs for ARIA
  const baseId = $derived(id ?? `filterable-dropdown-${Math.random().toString(36).slice(2, 9)}`);
  const listboxId = $derived(`${baseId}-listbox`);

  // Derived: selectable options only (excludes headers)
  const selectableOptions = $derived(options.filter((opt) => opt.type === "option"));

  // Derived: filtered options. The case-insensitive substring filter on the
  // label only applies to "option" entries; a header is kept iff its group
  // (the options that follow it, up to the next header) has at least one match.
  const filteredOptions = $derived.by(() => {
    if (filterText === "") return options;
    const lower = filterText.toLowerCase();
    const matches = (opt: DropdownOption): boolean => opt.label.toLowerCase().includes(lower);
    const result: DropdownOption[] = [];
    let pendingHeader: DropdownOption | null = null;
    for (const opt of options) {
      if (opt.type === "header") {
        pendingHeader = opt;
        continue;
      }
      if (matches(opt)) {
        if (pendingHeader !== null) {
          result.push(pendingHeader);
          pendingHeader = null;
        }
        result.push(opt);
      }
    }
    return result;
  });

  // Derived: filtered selectable options for navigation
  const filteredSelectableOptions = $derived(
    filteredOptions.filter((opt) => opt.type === "option")
  );

  // Derived: highlighted option ID
  const highlightedId = $derived.by(() => {
    const opt = filteredSelectableOptions[highlightedIndex];
    return opt !== undefined
      ? `${baseId}-option-${opt.value.replace(/[^a-zA-Z0-9-]/g, "-")}`
      : undefined;
  });

  // Scroll highlighted option into view when navigating with keyboard
  $effect(() => {
    if (highlightedId !== undefined) {
      const element = document.getElementById(highlightedId);
      element?.scrollIntoView({ block: "nearest" });
    }
  });

  /**
   * Calculate dropdown position based on input element's screen position.
   * Uses fixed positioning to escape container overflow clipping.
   */
  function updateDropdownPosition(): void {
    if (inputRef === undefined) return;
    const rect = inputRef.getBoundingClientRect();
    dropdownPosition = {
      top: rect.bottom,
      left: rect.left,
      width: rect.width,
    };
  }

  // Handle window resize while dropdown is open
  $effect(() => {
    if (!isOpen) return;

    updateDropdownPosition();
    window.addEventListener("resize", updateDropdownPosition);
    return () => {
      window.removeEventListener("resize", updateDropdownPosition);
    };
  });

  // Auto-open dropdown when typing produces matches
  $effect(() => {
    if (isTyping && filterText !== "" && filteredSelectableOptions.length > 0 && !isOpen) {
      isOpen = true;
    }
  });

  // The click that GIVES the input focus must not toggle the list shut again
  // right after the focus handler opened it.
  let focusJustReceived = false;

  function handleFocus(): void {
    if (!disabled) {
      isOpen = true;
    }
    focusJustReceived = true;
    setTimeout(() => {
      focusJustReceived = false;
    }, 0);
  }

  /** A non-searchable (select-like) control toggles its list on click. */
  function handleClick(): void {
    if (disabled || searchable || focusJustReceived) return;
    isOpen = !isOpen;
    if (!isOpen) highlightedIndex = -1;
  }

  function handleBlur(event: FocusEvent): void {
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    // Only keep open if focus stays within THIS dropdown (e.g., clicking an option)
    // Use inputRef's parent to identify this specific dropdown instance
    const thisDropdown = inputRef?.closest(".filterable-dropdown");
    if (thisDropdown && relatedTarget?.closest(".filterable-dropdown") === thisDropdown) {
      return;
    }

    // When allowFreeText is false, resolve typed text: select the exact label
    // match (canonicalizing case), otherwise revert to the prop value.
    if (!allowFreeText && localFilterOverride !== null) {
      const exactMatch = selectableOptions.find(
        (opt) => opt.label.toLowerCase() === localFilterOverride!.toLowerCase()
      );
      if (exactMatch === undefined) {
        // No valid match - revert to original prop value
        localFilterOverride = null;
      } else {
        selectOption(exactMatch.value);
      }
    }

    isOpen = false;
    highlightedIndex = -1;
    isTyping = false;
  }

  function handleInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    localFilterOverride = target.value;
    highlightedIndex = -1;
    isTyping = true;
    onInputCallback?.(target.value);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (disabled) return;

    const selectableCount = filteredSelectableOptions.length;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          isOpen = true;
        }
        if (selectableCount > 0) {
          highlightedIndex = highlightedIndex < selectableCount - 1 ? highlightedIndex + 1 : 0;
        }
        break;

      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          isOpen = true;
        }
        if (selectableCount > 0) {
          highlightedIndex = highlightedIndex > 0 ? highlightedIndex - 1 : selectableCount - 1;
        }
        break;

      case "Enter":
        event.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < selectableCount) {
          // Selecting an option from dropdown - don't trigger onEnter
          const highlightedOption = filteredSelectableOptions[highlightedIndex];
          if (highlightedOption !== undefined) {
            selectOption(highlightedOption.value);
          }
        } else {
          // No option highlighted: commit the typed text (free text emits it
          // as the value; otherwise an exact label match is selected), then
          // hand Enter to the parent (e.g. to trigger a form's primary action).
          if (allowFreeText) {
            if (displayText.trim() !== "") {
              selectFreeText(displayText.trim());
            }
          } else {
            const exactMatch = selectableOptions.find(
              (opt) => opt.label.toLowerCase() === filterText.toLowerCase()
            );
            if (exactMatch !== undefined) {
              selectOption(exactMatch.value);
            }
          }
          onEnter?.();
        }
        break;

      case "Escape":
        if (isOpen) {
          event.preventDefault();
          event.stopPropagation();
          isOpen = false;
          highlightedIndex = -1;
          isTyping = false;
        }
        break;

      case "Tab":
        if (highlightedIndex >= 0 && highlightedIndex < selectableCount) {
          // User navigated with arrow keys - select highlighted option
          const highlightedOption = filteredSelectableOptions[highlightedIndex];
          if (highlightedOption !== undefined) {
            selectOption(highlightedOption.value);
          }
        } else {
          // No highlighted option - check if typed text exactly matches an option
          const exactMatch = selectableOptions.find(
            (opt) => opt.label.toLowerCase() === filterText.toLowerCase()
          );
          if (exactMatch !== undefined) {
            selectOption(exactMatch.value);
          }
        }
        isOpen = false;
        break;
    }
  }

  function selectOption(optionValue: string): void {
    localFilterOverride = options.find((o) => o.value === optionValue)?.label ?? optionValue;
    isOpen = false;
    highlightedIndex = -1;
    isTyping = false;
    onSelect(optionValue);
  }

  /**
   * Handle free text selection (when allowFreeText is enabled).
   * Emits the typed text directly without matching to an option.
   */
  function selectFreeText(text: string): void {
    localFilterOverride = text;
    isOpen = false;
    highlightedIndex = -1;
    isTyping = false;
    onSelect(text);
  }

  /**
   * Handle mousedown on options to prevent blur and select in one action.
   */
  function handleOptionMouseDown(event: MouseEvent, optionValue: string): void {
    event.preventDefault();
    selectOption(optionValue);
  }

  /**
   * Get the index in filteredSelectableOptions for a given option.
   */
  function getSelectableIndex(option: DropdownOption): number {
    return filteredSelectableOptions.findIndex((o) => o.value === option.value);
  }
</script>

<div class="filterable-dropdown">
  <input
    bind:this={inputRef}
    id={id ? `${id}-input` : undefined}
    data-autofocus={autofocus || undefined}
    type="text"
    role="combobox"
    aria-expanded={isOpen}
    aria-controls={listboxId}
    aria-activedescendant={highlightedId}
    aria-autocomplete="list"
    aria-haspopup="listbox"
    aria-invalid={invalid ? "true" : undefined}
    aria-describedby={describedBy}
    class:invalid
    class:select-like={!searchable}
    value={displayText}
    {disabled}
    readonly={!searchable || undefined}
    {placeholder}
    onfocus={handleFocus}
    onclick={handleClick}
    onblur={handleBlur}
    oninput={handleInput}
    onkeydown={handleKeyDown}
  />

  {#if isOpen && dropdownPosition !== null && (filteredSelectableOptions.length > 0 || !allowFreeText)}
    <ul
      id={listboxId}
      class="dropdown-listbox"
      role="listbox"
      style="top: {dropdownPosition.top}px; left: {dropdownPosition.left}px; width: {dropdownPosition.width}px;"
    >
      {#if filteredSelectableOptions.length === 0}
        <li class="no-results">No matches found</li>
      {:else}
        {#each filteredOptions as option (option.value)}
          {#if option.type === "header"}
            <li class="group-header" role="presentation">
              {option.label}
            </li>
          {:else}
            {@const selectableIdx = getSelectableIndex(option)}
            {@const isHighlighted = highlightedIndex === selectableIdx}
            <li
              id={`${baseId}-option-${option.value.replace(/[^a-zA-Z0-9-]/g, "-")}`}
              role="option"
              class="dropdown-option"
              class:highlighted={isHighlighted}
              aria-selected={isHighlighted}
              onmousedown={(e: MouseEvent) => handleOptionMouseDown(e, option.value)}
            >
              {option.label}
            </li>
          {/if}
        {/each}
      {/if}
    </ul>
  {/if}
</div>

<style>
  .filterable-dropdown {
    position: relative;
    width: 100%;
  }

  input {
    width: 100%;
    padding: 6px 8px;
    background: var(--ch-input-bg);
    color: var(--ch-foreground);
    border: 1px solid var(--ch-input-border);
    border-radius: var(--ch-radius-sm, 6px);
    font-size: 13px;
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: var(--ch-focus-border);
  }

  input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Non-searchable (select-like) mode: read-only input acting as a button. */
  input.select-like {
    cursor: pointer;
    caret-color: transparent;
  }

  input.invalid {
    border-color: var(--ch-danger, #f14c4c);
  }

  .dropdown-listbox {
    position: fixed;
    max-height: 200px;
    overflow-y: auto;
    background: var(--ch-input-bg);
    border: 1px solid var(--ch-input-border);
    border-top: none;
    border-radius: 0 0 var(--ch-radius-sm, 6px) var(--ch-radius-sm, 6px);
    list-style: none;
    padding: 0;
    margin: 0;
    z-index: 100;
    box-sizing: border-box;
  }

  .group-header {
    padding: 6px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--ch-foreground);
    opacity: 0.6;
    background: var(--ch-background);
  }

  .dropdown-option {
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
  }

  .dropdown-option:hover,
  .dropdown-option.highlighted {
    background: var(--ch-list-active-bg);
    color: var(--ch-list-active-fg);
  }

  .dropdown-option[aria-selected="true"] {
    background: var(--ch-list-active-bg);
    color: var(--ch-list-active-fg);
  }

  .no-results {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--ch-foreground);
    opacity: 0.7;
  }
</style>
