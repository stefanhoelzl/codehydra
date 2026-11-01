<!--
  NoteCard.svelte

  One sidebar card: a notification in the stack at the bottom, or a question
  (`ch ws ask`) in its workspace's row. A question's buttons are its answers
  and its × cancels it; a card at the bottom that is about a workspace names
  it, and clicking the name goes there.
-->
<script lang="ts">
  import { emitEvent, sendNotificationEvent } from "$lib/api";
  import type { UiNotification } from "@shared/ui-state";
  import type { NotificationButton } from "@shared/notification-types";
  import SidebarIcon, { type SidebarIconName } from "./SidebarIcon.svelte";

  interface Props {
    note: UiNotification;
    /** Shown inside a workspace row (a question) rather than at the bottom. */
    inRow?: boolean;
    /** Play the counter bump when the count rises. */
    animate?: boolean;
  }

  const { note, inRow = false, animate = true }: Props = $props();

  const ICONS: Record<"info" | "warning" | "error" | "question", SidebarIconName> = {
    info: "info",
    warning: "warn",
    error: "xcircle",
    question: "help",
  };

  const config = $derived(note.config);
  const question = $derived(config.type === "question");
  /** A spinner card is styled as info, with a ring for its icon. */
  const tone = $derived(config.type === "spinner" ? "info" : config.type);
  const count = $derived(note.count ?? 1);
  const workspace = $derived(question ? undefined : note.workspace);

  let countEl = $state<HTMLElement | null>(null);
  let lastCount = 0;
  $effect(() => {
    const now = count;
    if (animate && lastCount > 0 && now > lastCount) {
      countEl?.animate([{ transform: "scale(1.5)" }, { transform: "scale(1)" }], { duration: 300 });
    }
    lastCount = now;
  });

  function act(action: NotificationButton): void {
    if (action.disabled === true || action.busy === true) return;
    sendNotificationEvent({ notificationId: note.id, actionId: action.id });
  }

  function dismiss(): void {
    sendNotificationEvent({ notificationId: note.id, actionId: "dismiss" });
  }

  function openWorkspace(key: string): void {
    emitEvent({ kind: "switch-workspace", key });
  }
</script>

<div
  class="note {tone}"
  class:in-row={inRow}
  data-note-id={note.id}
  role={question ? "dialog" : "status"}
  aria-label={config.title}
>
  <div class="nh">
    <span class="nicon">
      {#if config.type === "spinner"}
        <span class="ring"></span>
      {:else}
        <SidebarIcon name={ICONS[tone as keyof typeof ICONS]} />
      {/if}
    </span>
    <div class="nt">
      <div class="ntitle">
        {config.title}
        {#if count > 1}<span class="ncount" bind:this={countEl}>×{count}</span>{/if}
      </div>
      {#if workspace !== undefined}
        <button
          type="button"
          class="nws"
          title={`Go to ${workspace.name}`}
          onclick={() => openWorkspace(workspace.key)}
        >
          <SidebarIcon name="branch" class="sm" />{workspace.name}
        </button>
      {/if}
      {#if config.message}<div class="nmsg">{config.message}</div>{/if}
      {#if config.progress !== undefined}
        <div class="nprog">
          {#if config.progress === true}
            <div class="bar indet"><i></i></div>
          {:else}
            <div class="bar"><i style:width={`${Math.round(config.progress * 100)}%`}></i></div>
            <span class="pct">{Math.round(config.progress * 100)}%</span>
          {/if}
        </div>
      {/if}
      {#if config.actions && config.actions.length > 0}
        <div class="nacts">
          {#each config.actions as action (action.id)}
            <button
              type="button"
              class:primary={action.variant === "primary"}
              disabled={action.disabled === true || action.busy === true}
              onclick={() => act(action)}
            >
              {action.busy === true ? (action.busyLabel ?? action.label) : action.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
  {#if config.dismissible === true || question}
    <button
      type="button"
      class="ib nx"
      title={question ? "Cancel (no answer)" : "Dismiss"}
      aria-label={question ? "Cancel" : "Dismiss"}
      onclick={dismiss}
    >
      <SidebarIcon name="close" />
    </button>
  {/if}
</div>

<style>
  .note {
    position: relative;
    border-radius: 10px;
    background: var(--ch-sb-s2);
    border: 1px solid var(--ch-sb-line);
    padding: 8px 28px 8px 9px;
    flex-shrink: 0;
    color: var(--ch-sb-fg);
    cursor: default;
  }
  .note.error {
    background: color-mix(in srgb, var(--ch-sb-danger) 9%, var(--ch-sb-s2));
    border-color: color-mix(in srgb, var(--ch-sb-danger) 35%, transparent);
  }
  .note.warning {
    background: color-mix(in srgb, var(--ch-sb-warn) 8%, var(--ch-sb-s2));
    border-color: color-mix(in srgb, var(--ch-sb-warn) 32%, transparent);
  }
  .note.question {
    background: color-mix(in srgb, var(--ch-sb-ask) 10%, var(--ch-sb-s2));
    border-color: color-mix(in srgb, var(--ch-sb-ask) 40%, transparent);
  }
  .note.question .nicon {
    color: var(--ch-sb-ask);
  }
  .note.question .nacts {
    flex-wrap: wrap;
  }
  .note.question .nacts button {
    border-color: color-mix(in srgb, var(--ch-sb-ask) 45%, transparent);
  }
  .note.question .nacts button:hover {
    background: color-mix(in srgb, var(--ch-sb-ask) 18%, var(--ch-sb-s1));
    border-color: var(--ch-sb-ask);
  }
  .nws {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 0;
    background: transparent;
    padding: 0;
    margin-top: 1px;
    color: var(--ch-sb-fg-2);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    max-width: 100%;
  }
  .nws:hover {
    color: var(--ch-sb-fg);
    text-decoration: underline;
  }
  .nws :global(.sb-icon.sm) {
    width: 11px;
    height: 11px;
  }
  .nh {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .nicon {
    width: 16px;
    height: 18px;
    display: grid;
    place-items: center;
    flex: none;
  }
  .note.error .nicon {
    color: var(--ch-sb-danger);
  }
  .note.warning .nicon {
    color: var(--ch-sb-warn);
  }
  .note.info .nicon {
    color: var(--ch-sb-accent);
  }
  .nt {
    flex: 1;
    min-width: 0;
  }
  .ntitle {
    font-weight: 600;
    font-size: 12.5px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-wrap: anywhere;
  }
  .ncount {
    font-size: 10px;
    font-weight: 600;
    padding: 0 6px;
    border-radius: 99px;
    background: var(--ch-sb-s3);
    color: var(--ch-sb-fg-2);
    font-variant-numeric: tabular-nums;
  }
  .note.error .ncount {
    background: color-mix(in srgb, var(--ch-sb-danger) 22%, transparent);
    color: var(--ch-sb-danger);
  }
  .nmsg {
    font-size: 11.5px;
    color: var(--ch-sb-fg-2);
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .nprog {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .bar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--ch-sb-s3);
    overflow: hidden;
  }
  .bar > i {
    display: block;
    height: 100%;
    background: var(--ch-sb-accent);
    border-radius: 2px;
    transition: width 0.15s linear;
  }
  .bar.indet > i {
    width: 35%;
    animation: indet 1.2s ease-in-out infinite;
  }
  @keyframes indet {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
  .pct {
    font-size: 10.5px;
    color: var(--ch-sb-fg-3);
    font-variant-numeric: tabular-nums;
    min-width: 28px;
    text-align: right;
  }
  .nacts {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .nacts button {
    font: inherit;
    font-size: 11.5px;
    color: inherit;
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid var(--ch-sb-line-2);
    background: var(--ch-sb-s1);
    cursor: pointer;
  }
  .nacts button:hover {
    border-color: var(--ch-sb-fg-3);
  }
  .nacts button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .nacts .primary {
    background: var(--ch-sb-accent);
    color: #fff;
    border-color: transparent;
  }
  .ib {
    display: grid;
    place-items: center;
    border-radius: 7px;
    color: var(--ch-sb-fg-2);
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .ib:hover {
    background: var(--ch-sb-s3);
    color: var(--ch-sb-fg);
  }
  .nx {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 20px;
    height: 20px;
    padding: 0;
  }
  .nx :global(.sb-icon) {
    width: 12px;
    height: 12px;
  }
  .ring {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 2px solid var(--ch-sb-spin-track);
    border-top-color: var(--ch-sb-spin-head);
    animation: spin 0.9s linear infinite;
    display: block;
    box-sizing: border-box;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* inside a workspace row */
  .note.in-row {
    padding: 6px 26px 7px 8px;
    border-radius: 8px;
  }
  .note.in-row .nicon {
    width: 14px;
    height: 16px;
  }
  .note.in-row .nicon :global(.sb-icon) {
    width: 13px;
    height: 13px;
  }
  .note.in-row .ntitle {
    font-size: 12px;
  }
  .note.in-row .nacts {
    margin-top: 6px;
  }
  .note.in-row .nx {
    top: 3px;
    right: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    .ring,
    .bar.indet > i {
      animation: none;
    }
  }
</style>
