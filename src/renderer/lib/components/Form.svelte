<!--
  Form.svelte

  Generic declarative form/section renderer.
  Renders a DialogConfig's sections + actions by type: text, progress, selection,
  table, input. Actions are rendered as vscode-button elements in a footer row.

  Surface-agnostic: the wrapping surface (e.g. DialogView's modal card, or a
  future panel shell) provides the chrome and text alignment. Form only lays the
  sections out in a vertical flow.
-->
<script lang="ts">
  import type {
    DialogConfig,
    DialogAction,
    DialogUserEvent,
    ProgressItem,
  } from "@shared/dialog-types";
  import { onMount, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { sendDialogEvent } from "$lib/api";

  let formRef: HTMLElement | undefined;

  interface Props {
    dialogId: string;
    config: DialogConfig;
  }

  const { dialogId, config }: Props = $props();

  // Track selection state for selection sections
  let selectionState = $state<Record<number, string>>({});

  // Track input values for input sections (keyed by input id)
  let inputState = $state<Record<string, string>>({});

  // Initialize selection state when config changes (not when selection changes)
  $effect(() => {
    const newState: Record<number, string> = {};
    config.sections.forEach((section, index) => {
      if (section.type === "selection" && section.options.length > 0) {
        // Read existing selection without tracking — avoid circular dependency
        const existing = untrack(() => selectionState[index]);
        const stillValid = existing && section.options.some((o) => o.id === existing);
        newState[index] = stillValid ? existing : section.options[0]!.id;
      }
    });
    selectionState = newState;
  });

  // Seed input state from initialValue on first sight of each input id.
  // Existing edits are preserved; re-seeds would overwrite user content.
  $effect(() => {
    const seeded: Record<string, string> = {};
    let changed = false;
    for (const section of config.sections) {
      if (section.type !== "input") continue;
      const existing = untrack(() => inputState[section.id]);
      if (existing !== undefined) continue;
      if (section.initialValue !== undefined) {
        seeded[section.id] = section.initialValue;
        changed = true;
      }
    }
    if (changed) {
      inputState = { ...untrack(() => inputState), ...seeded };
    }
  });

  // Auto-focus the selected card on mount (for keyboard navigation)
  onMount(() => {
    setTimeout(() => {
      const selected = formRef?.querySelector("[aria-checked='true']") as HTMLElement | null;
      selected?.focus();
    }, 0);
  });

  /**
   * Focus the textarea and either select the seeded text or place the caret
   * at `cursorOffset`. Also re-focuses the textarea when Alt is released:
   * Chromium's default Alt-up handler activates the window menu and pulls
   * focus out of the WebContents, which after Alt+X+B would otherwise leave
   * the dialog with no caret. (Electron #37336 prevents us from suppressing
   * Alt at the keyDown layer.)
   */
  function seedCursor(
    node: HTMLTextAreaElement,
    params: {
      initialValue: string | undefined;
      cursorOffset: number | undefined;
      selectInitialValue: boolean | undefined;
    }
  ): { destroy: () => void } | void {
    if (params.initialValue === undefined) return;
    const length = params.initialValue.length;
    queueMicrotask(() => {
      node.focus();
      if (params.selectInitialValue) {
        node.setSelectionRange(0, length);
      } else if (params.cursorOffset !== undefined) {
        const offset = Math.max(0, Math.min(params.cursorOffset, length));
        node.setSelectionRange(offset, offset);
      }
      node.scrollTop = 0;
    });

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== "Alt") return;
      // Re-focus only if focus was stolen (active element is body / null).
      const active = document.activeElement;
      if (active === node) return;
      if (active && active !== document.body) return;
      queueMicrotask(() => {
        node.focus();
      });
    };
    window.addEventListener("keyup", onKeyUp, true);
    return {
      destroy(): void {
        window.removeEventListener("keyup", onKeyUp, true);
      },
    };
  }

  /** Get the current selection data to include in events.
   * NOTE: Supports one selection section per dialog. If multiple exist, last wins. */
  function getSelectionData(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    config.sections.forEach((section, index) => {
      if (section.type === "selection" && selectionState[index]) {
        data["selection"] = selectionState[index];
      }
    });
    return data;
  }

  /** Get input values to include in events. */
  function getInputData(): Record<string, string> {
    const inputs: Record<string, string> = {};
    for (const section of config.sections) {
      if (section.type === "input") {
        inputs[section.id] = inputState[section.id] ?? "";
      }
    }
    return inputs;
  }

  /** Handle action button click. */
  function handleAction(action: DialogAction): void {
    if (action.disabled || action.busy) return;
    const inputs = getInputData();
    const event: DialogUserEvent = {
      dialogId,
      actionId: action.id,
      data: {
        ...getSelectionData(),
        ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      },
    };
    sendDialogEvent(event);
  }

  /** Parse text content for {badge:text} syntax. Returns segments. */
  function parseTextContent(content: string): Array<{ type: "text" | "badge"; value: string }> {
    const segments: Array<{ type: "text" | "badge"; value: string }> = [];
    const regex = /\{badge:([^}]+)\}/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: "text", value: content.slice(lastIndex, match.index) });
      }
      segments.push({ type: "badge", value: match[1]! });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < content.length) {
      segments.push({ type: "text", value: content.slice(lastIndex) });
    }
    return segments;
  }

  /** Get icon name for a progress item status. */
  function getStatusIcon(status: ProgressItem["status"]): string {
    switch (status) {
      case "pending":
        return "circle-outline";
      case "running":
        return "sync";
      case "done":
        return "check";
      case "error":
        return "error";
    }
  }

  /** Get CSS class for a progress item status. */
  function getStatusClass(status: ProgressItem["status"]): string {
    switch (status) {
      case "done":
        return "status-done";
      case "error":
        return "status-error";
      default:
        return "";
    }
  }
</script>

<div class="form" bind:this={formRef}>
  {#each config.sections as section, sectionIndex (sectionIndex)}
    {@const s = section}
    {#if s.type === "text"}
      {#if s.style === "heading"}
        <h1 class="section-heading" class:has-icon={!!s.icon}>
          {#if s.icon}
            <span class="heading-icon" class:icon-error={s.icon === "error"}>
              <Icon name={s.icon} size={20} />
            </span>
          {/if}
          {#each parseTextContent(s.content) as seg, segIndex (segIndex)}
            {#if seg.type === "badge"}<vscode-badge>{seg.value}</vscode-badge
              >{:else}{seg.value}{/if}
          {/each}
        </h1>
      {:else if s.style === "subtitle"}
        <p class="section-subtitle">
          {#each parseTextContent(s.content) as seg, segIndex (segIndex)}
            {#if seg.type === "badge"}<vscode-badge>{seg.value}</vscode-badge
              >{:else}{seg.value}{/if}
          {/each}
        </p>
      {:else if s.style === "mono"}
        <pre class="section-mono">{s.content}</pre>
      {:else}
        <p class="section-text">
          {#each parseTextContent(s.content) as seg, segIndex (segIndex)}
            {#if seg.type === "badge"}<vscode-badge>{seg.value}</vscode-badge
              >{:else}{seg.value}{/if}
          {/each}
        </p>
      {/if}
    {:else if s.type === "progress"}
      <div class="progress-container" role="status" aria-live="polite" aria-atomic="false">
        {#each s.items as item, itemIndex (item.id)}
          <div class="progress-row" class:progress-row-error={item.status === "error"}>
            <div class="progress-row-header">
              <span class="progress-status {getStatusClass(item.status)}">
                <Icon name={getStatusIcon(item.status)} spin={item.status === "running"} />
              </span>
              <span class="progress-label">{item.label}</span>
              {#if item.message && item.status !== "error"}
                <span class="progress-message">{item.message}</span>
              {/if}
            </div>
            {#if item.message && item.status === "error"}
              <div class="progress-error-detail">{item.message}</div>
            {/if}
            {#if s.style !== "spinner"}
              <div class="progress-bar-track">
                {#if item.status === "running" && item.progress === undefined}
                  <vscode-progress-bar indeterminate={true} aria-label="{item.label} progress"
                  ></vscode-progress-bar>
                {:else}
                  {@const value =
                    item.status === "done"
                      ? 100
                      : item.status === "pending"
                        ? 0
                        : (item.progress ?? 0)}
                  <vscode-progress-bar
                    {value}
                    aria-label="{item.label} progress"
                    aria-valuenow={value}
                    aria-valuemin="0"
                    aria-valuemax="100"
                  ></vscode-progress-bar>
                {/if}
              </div>
            {/if}
          </div>
          {#if itemIndex < s.items.length - 1}
            <div class="progress-divider"></div>
          {/if}
        {/each}
      </div>
    {:else if s.type === "selection"}
      <div class="selection-cards" role="radiogroup" aria-label="Selection">
        {#each s.options as option, optionIndex (option.id)}
          <button
            type="button"
            class="selection-card"
            class:selected={selectionState[sectionIndex] === option.id}
            role="radio"
            aria-checked={selectionState[sectionIndex] === option.id}
            tabindex={selectionState[sectionIndex] === option.id ? 0 : -1}
            data-option={option.id}
            onclick={() => {
              selectionState = { ...selectionState, [sectionIndex]: option.id };
            }}
            onkeydown={(e) => {
              const opts = s.options;
              let targetIndex = -1;
              if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                targetIndex = optionIndex === 0 ? opts.length - 1 : optionIndex - 1;
              } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                targetIndex = optionIndex === opts.length - 1 ? 0 : optionIndex + 1;
              } else if (e.key === "Enter") {
                e.preventDefault();
                const primaryAction =
                  config.actions?.find((a) => a.variant !== "secondary") ?? config.actions?.[0];
                if (primaryAction) handleAction(primaryAction);
                return;
              } else if (e.key === " ") {
                e.preventDefault();
                selectionState = { ...selectionState, [sectionIndex]: option.id };
                return;
              }
              if (targetIndex >= 0) {
                const targetId = opts[targetIndex]!.id;
                selectionState = { ...selectionState, [sectionIndex]: targetId };
                const container = e.currentTarget.closest(".selection-cards");
                setTimeout(() => {
                  const card = container?.querySelector(
                    `[data-option="${targetId}"]`
                  ) as HTMLElement | null;
                  card?.focus();
                }, 0);
              }
            }}
          >
            {#if option.icon}
              <div class="selection-card-icon">
                <Icon name={option.icon} size={32} />
              </div>
            {/if}
            <span class="selection-card-title">{option.label}</span>
            <div class="selection-card-indicator">
              {#if selectionState[sectionIndex] === option.id}
                <Icon name="circle-filled" size={16} />
              {:else}
                <Icon name="circle-outline" size={16} />
              {/if}
            </div>
          </button>
        {/each}
      </div>
    {:else if s.type === "input"}
      {#if s.multiline}
        <textarea
          class="input-textarea"
          placeholder={s.placeholder ?? ""}
          aria-label={s.placeholder ?? "Text input"}
          value={inputState[s.id] ?? ""}
          use:seedCursor={{
            initialValue: s.initialValue,
            cursorOffset: s.cursorOffset,
            selectInitialValue: s.selectInitialValue,
          }}
          oninput={(e) => {
            inputState = { ...inputState, [s.id]: e.currentTarget.value };
          }}
        ></textarea>
      {:else}
        <vscode-textfield
          class="input-textfield"
          placeholder={s.placeholder ?? ""}
          aria-label={s.placeholder ?? "Text input"}
          value={inputState[s.id] ?? ""}
          oninput={(e: Event) => {
            inputState = { ...inputState, [s.id]: (e.currentTarget as HTMLInputElement).value };
          }}
        ></vscode-textfield>
      {/if}
    {:else if s.type === "table"}
      <div class="table-container">
        {#if s.header}
          <div class="table-header">
            {#if s.headerIcon}
              <span class="table-header-icon">
                <Icon name={s.headerIcon} />
              </span>
            {/if}
            <span>{s.header}</span>
          </div>
        {/if}
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                {#each s.columns as col (col.key)}
                  <th>{col.label}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each s.rows as row, rowIndex (rowIndex)}
                <tr>
                  {#each s.columns as col (col.key)}
                    <td>{row[col.key] ?? ""}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/each}

  {#if config.actions && config.actions.length > 0}
    <div class="actions">
      {#each config.actions as action (action.id)}
        <vscode-button
          appearance={action.variant === "secondary" ? "secondary" : undefined}
          disabled={action.disabled || action.busy || undefined}
          onclick={() => handleAction(action)}
          {...action.title ? { title: action.title } : {}}
        >
          {#if action.busy}
            {action.busyLabel ?? action.label}
          {:else}
            {action.label}
          {/if}
        </vscode-button>
      {/each}
    </div>
  {/if}
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

  /* ---- Text sections ---- */

  .section-heading {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .heading-icon {
    display: flex;
    align-items: center;
  }

  .icon-error {
    color: var(--ch-danger);
  }

  .section-subtitle {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .section-text {
    margin: 0;
    font-size: 0.875rem;
  }

  .section-mono {
    margin: 0;
    font-family: monospace;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
    width: 100%;
    padding: 0.75rem;
    background: color-mix(in srgb, var(--ch-foreground) 5%, transparent);
    border-radius: var(--ch-radius-sm, 6px);
  }

  /* ---- Progress sections ---- */

  .progress-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 400px;
    padding: 0.5rem;
    border-radius: var(--ch-radius-sm, 6px);
  }

  .progress-row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
  }

  .progress-row-error {
    border-radius: var(--ch-radius-sm, 6px);
  }

  .progress-divider {
    height: 1px;
    margin: 0 0.75rem;
    background: var(--ch-border);
  }

  .progress-row-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .progress-status {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    opacity: 0.7;
  }

  .progress-status.status-done {
    --vscode-icon-foreground: var(--ch-success, #89d185);
    color: var(--ch-success, #89d185);
    opacity: 1;
  }

  .progress-status.status-error {
    --vscode-icon-foreground: var(--ch-danger, #f14c4c);
    color: var(--ch-danger, #f14c4c);
    opacity: 1;
  }

  .progress-label {
    font-weight: 500;
    flex-shrink: 0;
  }

  .progress-message {
    margin-left: auto;
    font-size: 0.875rem;
    opacity: 0.7;
  }

  .progress-error-detail {
    margin-left: 28px;
    font-size: 0.75rem;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--ch-danger, #f14c4c);
    opacity: 0.85;
    word-break: break-word;
  }

  .progress-bar-track {
    width: 100%;
    height: 4px;
    background: var(--ch-input-background, rgba(255, 255, 255, 0.1));
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-bar-track :global(vscode-progress-bar) {
    width: 100%;
    height: 100%;
  }

  .spinner-inline {
    display: flex;
    align-items: center;
    height: 16px;
  }

  .spinner-inline :global(vscode-progress-ring) {
    width: 16px;
    height: 16px;
  }

  /* ---- Selection sections ---- */

  .selection-cards {
    display: flex;
    gap: 1rem;
    margin: 0.5rem 0;
  }

  .selection-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: 140px;
    padding: 1.5rem 1rem;
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-md, 10px);
    background: var(--ch-panel-background);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
    color: inherit;
    font-family: inherit;
  }

  .selection-card:hover {
    border-color: var(--ch-focus-border);
    background: var(--ch-accent-muted, var(--ch-list-hover-bg));
  }

  .selection-card:focus {
    outline: none;
    border-color: var(--ch-focus-border);
    box-shadow: 0 0 0 1px var(--ch-focus-border);
  }

  .selection-card.selected {
    border-color: var(--ch-focus-border);
    background: var(--ch-accent-muted, var(--ch-list-active-bg));
  }

  .selection-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
  }

  .selection-card-title {
    font-size: 1rem;
    font-weight: 500;
  }

  .selection-card-indicator {
    display: flex;
    align-items: center;
    opacity: 0.7;
  }

  .selection-card.selected .selection-card-indicator {
    opacity: 1;
    color: var(--ch-focus-border);
  }

  /* ---- Table sections ---- */

  .table-container {
    width: 100%;
    margin-top: 0.5rem;
    text-align: left;
  }

  .table-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .table-header-icon {
    display: flex;
    align-items: center;
    color: var(--ch-warning);
  }

  .table-scroll {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-sm, 6px);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  th {
    padding: 0.5rem 0.75rem;
    text-align: left;
    font-weight: 500;
    background: color-mix(in srgb, var(--ch-foreground) 5%, transparent);
    border-bottom: 1px solid var(--ch-border);
    position: sticky;
    top: 0;
  }

  td {
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, var(--ch-border) 50%, transparent);
  }

  tr:last-child td {
    border-bottom: none;
  }

  /* ---- Input sections ---- */

  .input-textarea {
    width: 100%;
    min-height: 30vh;
    max-height: 60vh;
    padding: 0.5rem;
    font-family: inherit;
    font-size: 0.875rem;
    color: var(--ch-foreground);
    background: var(--ch-input-background);
    border: 1px solid var(--ch-border);
    border-radius: var(--ch-radius-sm, 6px);
    resize: vertical;
  }

  .input-textarea:focus {
    outline: none;
    border-color: var(--ch-focus-border);
  }

  .input-textarea::placeholder {
    color: var(--ch-foreground-dim, rgba(255, 255, 255, 0.5));
  }

  .input-textfield {
    width: 100%;
  }

  /* ---- Actions ---- */

  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
</style>
