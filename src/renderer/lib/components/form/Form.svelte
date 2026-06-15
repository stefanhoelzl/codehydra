<!--
  Form.svelte

  Generic declarative form renderer: renders a DialogConfig's sections
  through the shared Section dispatcher (one leaf component per section type;
  GroupSection re-enters the dispatcher for its items) and owns everything
  form-global:

  - field values (and dropdown display text), reconciled against config pushes
  - the field-change channel (per-field debounce, cancel-on-submit)
  - autofocus placement and focus-follow on config updates
  - primary-action resolution (Enter submit) and action/change event emission
  - the form-global keyboard contract: Escape clicks the first enabled
    cancel-role button (a modal with none swallows Escape; a panel falls back
    to a "dismiss" event the session owner interprets), Cmd/Ctrl+Enter fires
    the primary action, Tab/Shift+Tab is trapped at the form boundary

  Leaves are controlled components: they receive their narrowed section config
  plus current value and report raw interactions back via callbacks; Form
  decides timing and payloads. Every button click emits an action event with
  the button's id and the full field-values snapshot.

  Surface-agnostic: the wrapping surface (e.g. DialogView's modal card, or the
  panel shell) provides the chrome and text alignment. Form only lays the
  sections out in a vertical flow. `config.layout` switches the section
  layout: "centered" (default) is the centered stack; "form" is left-aligned
  labeled rows.
-->
<script lang="ts">
  import type {
    DialogConfig,
    DialogSection,
    DialogSurface,
    DialogUserEvent,
  } from "@shared/dialog-types";
  import { onMount, onDestroy, untrack } from "svelte";
  import { sendDialogEvent } from "$lib/api";
  import { trapTabKey, getFocusables } from "$lib/utils/focus-trap";
  import Section from "./Section.svelte";
  import type {
    ButtonItem,
    CheckboxSectionConfig,
    DropdownSectionConfig,
    FieldSectionConfig,
  } from "./types";

  let formRef: HTMLElement | undefined;

  interface Props {
    dialogId: string;
    config: DialogConfig;
    /**
     * Hosting surface. Governs Escape when no enabled cancel-role button
     * exists: a "modal" swallows it (no-op); a "panel" emits a dismiss event.
     */
    surface?: DialogSurface;
  }

  const { dialogId, config, surface = "modal" }: Props = $props();

  /**
   * All field sections of the config in declaration order — top-level
   * input/radio/dropdown sections plus input/dropdown items nested in groups.
   */
  function fieldSectionsOf(cfg: DialogConfig): FieldSectionConfig[] {
    const fields: FieldSectionConfig[] = [];
    for (const section of cfg.sections) {
      if (
        section.type === "input" ||
        section.type === "radio" ||
        section.type === "dropdown" ||
        section.type === "checkbox"
      ) {
        fields.push(section);
      } else if (section.type === "group") {
        for (const item of section.items) {
          if (item.type === "input" || item.type === "dropdown") {
            fields.push(item);
          }
        }
      }
    }
    return fields;
  }

  // Section layout: "centered" (default) keeps the centered stack; "form" lays
  // fields out as left-aligned labeled rows with right-aligned actions.
  const layout = $derived(config.layout ?? "centered");

  /**
   * Stable keys for the sections each-block, so a config push that inserts or
   * removes sections (e.g. async warnings arriving above the button row) does
   * NOT recreate the DOM of the sections below it — recreating the focused
   * control drops focus to <body>, where the form-global keyboard contract
   * can't see it. Field sections key on their unique id; groups on their
   * items' ids; anonymous sections (text/progress/table) fall back to
   * type + occurrence — they shift on insertions but never hold focus.
   * The occurrence counter also guarantees key uniqueness.
   */
  function sectionKeysOf(sections: readonly (DialogSection | ButtonItem)[]): string[] {
    const counters: Record<string, number> = {};
    return sections.map((section) => {
      const base =
        section.type === "input" ||
        section.type === "radio" ||
        section.type === "dropdown" ||
        section.type === "checkbox"
          ? `field:${section.id}`
          : section.type === "group"
            ? `group:${section.items.map((item) => item.id).join("+")}`
            : section.type;
      const occurrence = counters[base] ?? 0;
      counters[base] = occurrence + 1;
      return occurrence === 0 ? base : `${base}:${occurrence}`;
    });
  }

  const sectionKeys = $derived(sectionKeysOf(config.sections));

  // Track all field values (radio + dropdown + input) keyed by field id.
  let fieldValues = $state<Record<string, string>>({});

  // Dropdown display text keyed by field id: what the combobox input shows,
  // which can differ from the reported value after a suggestion pick (the
  // input displays the suggestion's label while the field reports its value).
  let dropdownDisplay = $state<Record<string, string>>({});

  /** A dropdown section's suggestions flattened across groups. */
  function flatSuggestions(
    section: DropdownSectionConfig
  ): readonly { value: string; label: string }[] {
    return section.suggestions.flatMap((group) => group.items);
  }

  /** The label of the suggestion with this value, or the value itself. */
  function suggestionLabel(section: DropdownSectionConfig, value: string): string {
    return flatSuggestions(section).find((o) => o.value === value)?.label ?? value;
  }

  // Last backend-pushed `value` adopted per dropdown field. A deliberately
  // non-reactive record: only the reconcile effect reads/writes it, to decide
  // whether a config's `value` is new (adopt) or a re-send (preserve edits).
  const adoptedValues: Record<string, string> = {};

  // Reconcile field values whenever the config changes: rebuild the map so it
  // mirrors the current field sections (dropping removed-field keys) while
  // preserving values for fields that remain.
  // - radio: keep the existing choice if still a valid option id, else the
  //   first option's id.
  // - dropdown (controlled): when the config carries a `value` the renderer
  //   has not adopted yet, adopt it (strict mode falls back below when it
  //   names no suggestion). Re-sends of the same value preserve user edits.
  // - dropdown (freeText): like input — keep existing edits/picks, else seed
  //   from initialValue on first sight.
  // - dropdown (strict): keep the existing choice if still a valid suggestion
  //   value; on first sight start at initialValue when it names a suggestion;
  //   else the first suggestion's value. Display text follows the value
  //   (suggestion label) unless the value is unchanged (preserving what the
  //   user sees, e.g. typed free text).
  // - input: keep existing edits/seeded value; otherwise seed from initialValue
  //   on first sight (a later initialValue change does not re-seed).
  // Existing values are read via untrack to avoid a write -> retrigger loop.
  $effect(() => {
    const next: Record<string, string> = {};
    const nextDisplay: Record<string, string> = {};
    for (const section of fieldSectionsOf(config)) {
      if (section.type === "radio") {
        const existing = untrack(() => fieldValues[section.id]);
        const stillValid = existing !== undefined && section.options.some((o) => o.id === existing);
        next[section.id] = stillValid ? existing : (section.options[0]?.id ?? "");
      } else if (section.type === "dropdown") {
        const existing = untrack(() => fieldValues[section.id]);
        const pushed =
          section.value !== undefined && section.value !== adoptedValues[section.id]
            ? section.value
            : undefined;
        if (pushed !== undefined) {
          adoptedValues[section.id] = pushed;
        }
        if (section.freeText) {
          next[section.id] = pushed ?? existing ?? section.initialValue ?? "";
        } else {
          const isValid = (v: string | undefined): v is string =>
            v !== undefined && flatSuggestions(section).some((o) => o.value === v);
          next[section.id] = isValid(pushed)
            ? pushed
            : pushed === undefined && isValid(existing)
              ? existing
              : existing === undefined && pushed === undefined && isValid(section.initialValue)
                ? section.initialValue
                : (flatSuggestions(section)[0]?.value ?? "");
        }
        const existingDisplay = untrack(() => dropdownDisplay[section.id]);
        nextDisplay[section.id] =
          next[section.id] === existing && existingDisplay !== undefined && pushed === undefined
            ? existingDisplay
            : suggestionLabel(section, next[section.id]!);
      } else if (section.type === "input") {
        const existing = untrack(() => fieldValues[section.id]);
        next[section.id] = existing ?? section.initialValue ?? "";
      } else if (section.type === "checkbox") {
        // Controlled push with the dropdown's adopt-once semantics: adopt a
        // pushed value the renderer has not seen yet; re-sends preserve the
        // user's toggles. Absent value = starts unchecked.
        const existing = untrack(() => fieldValues[section.id]);
        const pushedRaw = section.value === undefined ? undefined : String(section.value);
        const pushed =
          pushedRaw !== undefined && pushedRaw !== adoptedValues[section.id]
            ? pushedRaw
            : undefined;
        if (pushed !== undefined) {
          adoptedValues[section.id] = pushed;
        }
        next[section.id] = pushed ?? existing ?? "false";
      }
    }
    fieldValues = next;
    dropdownDisplay = nextDisplay;
  });

  // ---- Field-change channel ----
  // Per-field debounce timers, keyed by field id. A deliberately non-reactive
  // plain record (never read in a reactive context). Emission is driven ONLY by
  // user-interaction handlers (clicks, keystrokes), never by the reconcile
  // effect above — so backend-driven config updates never re-emit (no loop).
  const changeTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  /**
   * Effective debounce (ms) for a field's change-event opt-in, or null when the
   * field does not opt in. Default debounce per field type: continuous editing
   * (input, dropdown typing) 200ms, discrete fields (radio, checkbox) 0ms
   * (immediate). Dropdown suggestion picks bypass this entirely (see
   * handleDropdownSelect).
   */
  function changeDebounceMs(section: FieldSectionConfig): number | null {
    const cfg = section.changeEvent;
    if (!cfg) return null;
    const fallback = section.type === "radio" || section.type === "checkbox" ? 0 : 200;
    if (cfg === true) return fallback;
    return cfg.debounceMs ?? fallback;
  }

  /** Whether the dialog still has a field with this id. */
  function hasField(fieldId: string): boolean {
    return fieldSectionsOf(config).some((s) => s.id === fieldId);
  }

  /** Send a field-change event with the full keyed-values snapshot. */
  function emitChange(fieldId: string): void {
    // A config update may have removed the field while its timer was pending.
    if (!hasField(fieldId)) return;
    const event: DialogUserEvent = {
      kind: "change",
      dialogId,
      fieldId,
      data: getValues(),
    };
    sendDialogEvent(event);
  }

  /**
   * Emit a change event for a field per its opt-in: immediately when the
   * effective debounce is 0, otherwise on the trailing edge of a per-field
   * timer. No-op for fields that did not opt in.
   */
  function scheduleChange(section: FieldSectionConfig): void {
    const debounce = changeDebounceMs(section);
    if (debounce === null) return;
    const fieldId = section.id;
    const pending = changeTimers[fieldId];
    if (pending !== undefined) {
      clearTimeout(pending);
      delete changeTimers[fieldId];
    }
    if (debounce <= 0) {
      emitChange(fieldId);
      return;
    }
    changeTimers[fieldId] = setTimeout(() => {
      delete changeTimers[fieldId];
      emitChange(fieldId);
    }, debounce);
  }

  /** Cancel all pending change timers (on submit or unmount). */
  function cancelChangeTimers(): void {
    for (const [fieldId, timer] of Object.entries(changeTimers)) {
      clearTimeout(timer);
      delete changeTimers[fieldId];
    }
  }

  onDestroy(() => {
    cancelChangeTimers();
  });

  /** Focus the control marked data-autofocus (after a tick for mounting). */
  function focusAutofocusTarget(): void {
    setTimeout(() => {
      const target = formRef?.querySelector<HTMLElement>("[data-autofocus]");
      target?.focus();
    }, 0);
  }

  /**
   * Re-place focus on the autofocus control. Exposed for hosting surfaces
   * that regain focus ownership (e.g. the panel when the last modal stacked
   * above it closes and focus would otherwise be lost to <body>).
   */
  export function refocus(): void {
    focusAutofocusTarget();
  }

  /** The id of the control carrying the autofocus flag, or null. */
  function autofocusIdOf(cfg: DialogConfig): string | null {
    for (const section of cfg.sections) {
      if (section.type === "group") {
        for (const item of section.items) {
          if (item.autofocus) return item.id;
        }
      } else if (
        (section.type === "input" ||
          section.type === "dropdown" ||
          section.type === "radio" ||
          section.type === "checkbox") &&
        section.autofocus
      ) {
        return section.id;
      }
    }
    return null;
  }

  /**
   * The mount-time default focus target when no control carries an explicit
   * autofocus flag: the first enabled field control (a focusable element that
   * is not a footer/side-flow button — vscode-button), else the primary
   * button. Field controls cover inputs, dropdowns, checkboxes, and the
   * selected radio card (the only tabbable card), so this subsumes the old
   * "focus the selected radio card" fallback. Runs at mount only — config
   * updates never re-home focus unless an explicit flag moves (see below).
   */
  function defaultFocusTarget(): HTMLElement | null {
    if (!formRef) return null;
    const firstField = getFocusables(formRef).find(
      (el) => el.tagName.toLowerCase() !== "vscode-button"
    );
    if (firstField) return firstField;
    return formRef.querySelector<HTMLElement>("vscode-button[data-primary]:not([disabled])");
  }

  // Auto-focus on mount: an explicit autofocus control wins, else the
  // computed default target (first enabled field, else the primary button).
  onMount(() => {
    setTimeout(() => {
      const explicit = formRef?.querySelector<HTMLElement>("[data-autofocus]");
      if (explicit) {
        explicit.focus();
        return;
      }
      defaultFocusTarget()?.focus();
    }, 0);
  });

  // Focus follows when a config update MOVES the autofocus flag to a
  // different control (e.g. picker button -> name field once a project
  // exists). Re-sends of the same target never steal focus; the initial
  // target is handled by onMount.
  let lastAutofocusId: string | null | undefined;
  $effect(() => {
    const id = autofocusIdOf(config);
    if (lastAutofocusId === undefined) {
      lastAutofocusId = id;
      return;
    }
    if (id !== null && id !== lastAutofocusId) {
      focusAutofocusTarget();
    }
    lastAutofocusId = id;

    // Safety net: stable section keys keep the focused control's DOM alive
    // across ordinary shape changes, but an update can still replace the
    // node holding focus (the control's section left the config, or its
    // group's identity changed), dropping focus to <body> — where the form's
    // keyboard contract (Escape, Tab trap) can no longer see it. When an
    // update orphans focus, restore the autofocus target. Focus parked
    // anywhere real (a field, the workspace iframe) is left alone.
    if (id !== null) {
      setTimeout(() => {
        const active = document.activeElement;
        if (active === document.body || active === null) {
          focusAutofocusTarget();
        }
      }, 0);
    }
  });

  /** Snapshot every field's current value, keyed by field id. */
  function getValues(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const section of fieldSectionsOf(config)) {
      values[section.id] = fieldValues[section.id] ?? "";
    }
    return values;
  }

  /**
   * A field reported a new value (input typing, radio selection): track it and
   * emit a change event per the field's opt-in (debounced for typing,
   * immediate for radio).
   */
  function handleFieldValue(section: FieldSectionConfig, value: string): void {
    fieldValues = { ...fieldValues, [section.id]: value };
    scheduleChange(section);
  }

  /**
   * A suggestion was picked (or free text committed via Enter/Tab): report the
   * picked value, display its label, and emit immediately — a pick is a
   * discrete action, so it bypasses the typing debounce (cancelling any
   * pending typing emit so the backend never sees stale text after the pick).
   */
  function handleDropdownSelect(section: DropdownSectionConfig, value: string): void {
    fieldValues = { ...fieldValues, [section.id]: value };
    dropdownDisplay = { ...dropdownDisplay, [section.id]: suggestionLabel(section, value) };
    if (!section.changeEvent) return;
    const pending = changeTimers[section.id];
    if (pending !== undefined) {
      clearTimeout(pending);
      delete changeTimers[section.id];
    }
    emitChange(section.id);
  }

  /**
   * The user typed in a dropdown. In free-text mode the typed text IS the
   * field value (debounced change). In strict mode typing only filters the
   * suggestion list — purely presentational, never reported.
   */
  function handleDropdownInput(section: DropdownSectionConfig, text: string): void {
    if (!section.freeText) return;
    fieldValues = { ...fieldValues, [section.id]: text };
    dropdownDisplay = { ...dropdownDisplay, [section.id]: text };
    scheduleChange(section);
  }

  /**
   * A checkbox was toggled: track the new state as "true"/"false" and emit a
   * change event per the field's opt-in (immediate — a toggle is discrete).
   */
  function handleCheckboxToggle(section: CheckboxSectionConfig, checked: boolean): void {
    handleFieldValue(section, checked ? "true" : "false");
  }

  /**
   * Activate the form's primary button: the first button declared with an
   * explicit variant "primary". Without one this does nothing — a positional
   * fallback could land on a field-attached side-flow button.
   */
  function triggerPrimaryAction(): void {
    const primaryButton = findPrimaryButton(config);
    if (primaryButton) handleButton(primaryButton);
  }

  /** Handle a button click: emit an action event with the values snapshot. */
  function handleButton(button: ButtonItem): void {
    if (button.disabled || button.busy) return;
    // The action event carries the full snapshot, so any pending debounced
    // change is redundant — cancel it to avoid a stray emit after submit.
    cancelChangeTimers();
    const event: DialogUserEvent = {
      dialogId,
      actionId: button.id,
      data: getValues(),
    };
    sendDialogEvent(event);
  }

  /**
   * The button Enter activates from a radio group: the first button declared
   * with an explicit variant "primary". Without one, Enter does nothing — a
   * positional fallback could land on a field-attached side-flow button.
   */
  function findPrimaryButton(cfg: DialogConfig): ButtonItem | undefined {
    for (const section of cfg.sections) {
      if (section.type !== "group") continue;
      for (const item of section.items) {
        if (item.type === "button" && item.variant === "primary") return item;
      }
    }
    return undefined;
  }

  /**
   * The button Escape activates: the first enabled (non-disabled, non-busy)
   * button declared with role "cancel". Returns undefined when there is none
   * (or the only cancel-role button is currently unavailable) — Escape then
   * swallows on a modal, or dismisses on a panel.
   */
  function findCancelButton(cfg: DialogConfig): ButtonItem | undefined {
    for (const section of cfg.sections) {
      if (section.type !== "group") continue;
      for (const item of section.items) {
        if (item.type === "button" && item.role === "cancel" && !item.disabled && !item.busy) {
          return item;
        }
      }
    }
    return undefined;
  }

  /**
   * Form-global keyboard contract, on the bubble phase so field-level handlers
   * run first — e.g. an open dropdown consumes Escape (stopPropagation) to
   * close itself; only a second Escape reaches the form and dismisses the
   * session. Must be a template handler: Svelte delegates template keydowns to
   * the app root and replays them target-to-root, so only a delegated handler
   * keeps that ordering with the field components' handlers.
   * - Escape clicks the first enabled cancel-role button (identical to a real
   *   click). With none, a modal swallows Escape (no-op); a panel emits a
   *   "dismiss" event the session owner interprets (typically reset).
   * - Cmd/Ctrl+Enter activates the primary button from anywhere in the form.
   * - Tab/Shift+Tab is trapped at the form boundary so focus never leaks out.
   */
  function handleKeydown(event: KeyboardEvent): void {
    // A field-level handler that consumed the key (dropdown Enter/Escape,
    // input Enter, radio Enter) marks it defaultPrevented — stay out.
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      triggerPrimaryAction();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const cancel = findCancelButton(config);
      if (cancel) {
        handleButton(cancel);
      } else if (surface === "panel") {
        const dismiss: DialogUserEvent = { kind: "dismiss", dialogId };
        sendDialogEvent(dismiss);
      }
      // Modal with no enabled cancel-role button: Escape is a no-op.
      return;
    }
    if (formRef) {
      trapTabKey(event, formRef);
    }
  }
</script>

<!-- role="none": the form root is pure layout; the keydown handler is the
     form-global keyboard contract, not a widget interaction. -->
<div
  class="form"
  class:layout-form={layout === "form"}
  role="none"
  bind:this={formRef}
  onkeydown={handleKeydown}
>
  <!-- The recursive section snippet: GroupSection renders its items through
       it, re-entering the dispatcher without importing it (acyclic imports). -->
  {#snippet renderSection(section: DialogSection | ButtonItem)}
    <Section
      {section}
      {layout}
      values={fieldValues}
      displays={dropdownDisplay}
      renderItem={renderSection}
      onInput={handleFieldValue}
      onSelect={handleFieldValue}
      onPick={handleDropdownSelect}
      onType={handleDropdownInput}
      onToggle={handleCheckboxToggle}
      onAction={handleButton}
      onSubmit={triggerPrimaryAction}
    />
  {/snippet}
  {#each config.sections as section, sectionIndex (sectionKeys[sectionIndex])}
    {@render renderSection(section)}
  {/each}
</div>

<style>
  /* ---- Form root (inner layout) ---- */
  /* Surface chrome + text alignment come from the wrapping surface (e.g. the
     modal card in DialogView). Form only stacks sections vertically. */

  .form {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
  }

  /* Form-layout mode: left-aligned labeled rows. */
  .form.layout-form {
    align-items: stretch;
    text-align: left;
  }
</style>
