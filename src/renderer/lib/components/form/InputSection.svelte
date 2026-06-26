<!--
  InputSection.svelte

  Input section leaf: single-line text field or multi-line textarea, with the
  field's own optional label above and error helper below. The value is
  controlled by the owner (Form): every keystroke reports the new text via
  onInput; Enter in a single-line field reports onSubmit.
-->
<script lang="ts">
  import type { InputSectionConfig } from "./types";

  interface Props {
    section: InputSectionConfig;
    value: string;
    onInput: (value: string) => void;
    onSubmit: () => void;
  }

  const { section, value, onInput, onSubmit }: Props = $props();

  /**
   * Focus the textarea and optionally select the seeded text. Also re-focuses
   * the textarea when Alt is released: Chromium's default Alt-up handler
   * activates the window menu and pulls focus out of the WebContents, which
   * after Alt+X+B would otherwise leave the dialog with no caret. (Electron
   * #37336 prevents us from suppressing Alt at the keyDown layer.)
   */
  function seedCursor(
    node: HTMLTextAreaElement,
    params: {
      initialValue: string | undefined;
      selectInitialValue: boolean | undefined;
    }
  ): { destroy: () => void } | void {
    if (params.initialValue === undefined) return;
    const length = params.initialValue.length;
    queueMicrotask(() => {
      node.focus();
      if (params.selectInitialValue) {
        node.setSelectionRange(0, length);
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

  /**
   * Enter in a single-line input activates the primary action (same as Enter
   * in a dropdown). The action snapshot carries the typed value, so a pending
   * debounced change is irrelevant. Attached as an action because the
   * vscode-textfield custom element is opaque to the a11y template checks.
   */
  function submitOnEnter(node: HTMLElement): { destroy(): void } {
    const handler = (e: KeyboardEvent): void => {
      // Plain Enter submits the single-line field; Cmd/Ctrl+Enter is the
      // form-global gesture, handled by Form (let it fall through here).
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onSubmit();
      }
    };
    node.addEventListener("keydown", handler);
    return {
      destroy(): void {
        node.removeEventListener("keydown", handler);
      },
    };
  }
</script>

<div class="form-field">
  {#if section.label}
    <vscode-label for={section.id}>{section.label}</vscode-label>
  {/if}
  {#if section.multiline}
    <textarea
      class="input-textarea"
      class:errored={!!section.error}
      class:fixed-rows={section.rows !== undefined}
      id={section.id}
      rows={section.rows}
      placeholder={section.placeholder ?? ""}
      disabled={section.disabled || undefined}
      data-autofocus={section.autofocus || undefined}
      aria-label={section.label ? undefined : (section.placeholder ?? "Text input")}
      aria-invalid={section.error ? "true" : undefined}
      aria-describedby={section.error ? `${section.id}-error` : undefined}
      {value}
      use:seedCursor={{
        initialValue: section.initialValue,
        selectInitialValue: section.selectInitialValue,
      }}
      oninput={(e) => {
        onInput(e.currentTarget.value);
      }}
    ></textarea>
  {:else}
    <vscode-textfield
      class="input-textfield"
      id={section.id}
      invalid={section.error ? true : undefined}
      placeholder={section.placeholder ?? ""}
      disabled={section.disabled || undefined}
      data-autofocus={section.autofocus || undefined}
      aria-label={section.label ? undefined : (section.placeholder ?? "Text input")}
      aria-invalid={section.error ? "true" : undefined}
      aria-describedby={section.error ? `${section.id}-error` : undefined}
      {value}
      oninput={(e: Event) => {
        onInput((e.currentTarget as HTMLInputElement).value);
      }}
      use:submitOnEnter
    ></vscode-textfield>
  {/if}
  {#if section.error}
    <vscode-form-helper id="{section.id}-error">
      <span class="field-error">{section.error}</span>
    </vscode-form-helper>
  {/if}
</div>

<style>
  /* Field wrapper: groups the field's label, control, and error tightly so
     the error sits directly under its control (the form's section gap only
     applies between sections). */
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
  }

  /* Per-field validation error (slotted into <vscode-form-helper>). */
  .field-error {
    color: var(--ch-danger, #f14c4c);
    font-size: 0.75rem;
  }

  .input-textarea {
    width: 100%;
    min-height: 30vh;
    max-height: 60vh;
    padding: 0.5rem;
    font-family: inherit;
    font-size: 0.875rem;
    color: var(--ch-foreground);
    /* Same surface as the other inputs (FilterableDropdown, vscode-textfield
       both resolve to --vscode-settings-textInputBackground). */
    background: var(--ch-input-bg);
    border: 1px solid var(--ch-input-border);
    border-radius: var(--ch-radius-sm, 6px);
    resize: vertical;
  }

  .input-textarea:focus {
    outline: none;
    border-color: var(--ch-focus-border);
  }

  .input-textarea.errored {
    border-color: var(--ch-danger, #f14c4c);
  }

  /* An explicit `rows` controls the initial height (user can still resize). */
  .input-textarea.fixed-rows {
    min-height: 0;
  }

  .input-textarea::placeholder {
    color: var(--ch-foreground-dim, rgba(255, 255, 255, 0.5));
  }

  .input-textfield {
    width: 100%;
  }
</style>
