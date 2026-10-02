/**
 * The presenter's "system dialog": the startup surfaces and the mid-session
 * loading panel.
 *
 * Everything the user sees before app:started — boot splash, first-run setup,
 * agent selection, workspace loading — and the mid-session "workspace still
 * opening" (or "could not open") overlay is one dialog handle reconciled from
 * state on every push. The startup surfaces are modals over a blank
 * `main: { kind: "starting" }` base; the mid-session surface is a "panel" (no
 * blur/dim) below the sidebar over the not-yet-mounted frame.
 *
 * Also owns the startup phase itself: the app:start / app:setup hooks that move
 * it, the setup rows, the parked agent pick and setup retry, and the end of the
 * startup screen once every startup project:open has announced its workspaces.
 */

import type { IDispatcher, IntentInterceptor } from "../../intents/lib/dispatcher";
import type { Intent } from "../../intents/lib/types";
import type { HookOutput } from "../../intents/lib/operation";
import { ANY_VALUE } from "../../intents/lib/operation";
import type { Logger } from "../../boundaries/platform/logging";
import { INTENT_APP_SHUTDOWN, type AppShutdownIntent } from "../../intents/app-shutdown";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import type { ShowUIHookResult, AgentSelectionHookContext } from "../../intents/app-start";
import type { APP_START_OPERATION_ID } from "../../intents/app-start";
import {
  EVENT_SETUP_PROGRESS,
  EVENT_SETUP_ERROR,
  type SETUP_OPERATION_ID,
} from "../../intents/setup";
import type { LifecycleAgentType } from "../../shared/ipc";
import {
  EVENT_PROJECT_OPEN_FAILED,
  INTENT_OPEN_PROJECT,
  type ProjectOpenedEvent,
  type ProjectOpenFailedEvent,
} from "../../intents/open-project";
import {
  INTENT_SWITCH_WORKSPACE,
  type SwitchWorkspaceIntent,
} from "../../intents/switch-workspace";
import type {
  DialogActionEvent,
  DialogConfig,
  DialogSection,
  DialogKind,
  ProgressItem,
} from "../../shared/dialog-types";
import type { WorkspaceRef } from "../../intents/contract";
import { getErrorMessage } from "../../shared/error-utils";
import type { DialogHandle, DialogManager } from "./sessions";
import type { RunningHook, RunningHooks } from "./running-hooks";
import type { PresentationModel, RowEntry } from "./view-model";
import {
  isIntent,
  type AppEventDeclarations,
  type HookInput,
  type HooksOf,
} from "../../intents/declarations";

/**
 * Startup phase. "starting" is the genesis state (boot splash); "agent-selection"
 * is pushed by app:start's picker hook and "setup" by the app:setup hooks;
 * "running" is reached once app:start's `start` hook fires (app:ready dispatched)
 * and stays until the startup screen ends, after which the normal main logic
 * owns the view ("done").
 */
type StartupPhase = "starting" | "setup" | "agent-selection" | "running" | "done";

/** A first-run setup progress row, accumulated from setup:progress events. */
interface SetupRow {
  readonly id: string;
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "error";
  readonly message?: string;
  readonly progress?: number;
}

const SETUP_ROW_LABELS: Record<string, string> = {
  vscode: "VSCode",
  agent: "Agent",
  setup: "Setup",
};
const SETUP_ROW_IDS = ["vscode", "agent", "setup"] as const;

/** Action-id prefix of a running hook's Cancel button on the loading surface. */
const CANCEL_HOOK_ACTION = "cancel-hook:";
/** Action ids of the failed-open panel's buttons. */
const RETRY_OPEN_ACTION = "retry-open";
const DELETE_FAILED_ACTION = "delete-failed-open";

/** A centered spinner + label (boot splash / loading), via a spinner row. */
function spinnerConfig(label: string): DialogConfig {
  return {
    sections: [
      { type: "progress", style: "spinner", items: [{ id: "status", label, status: "running" }] },
    ],
  };
}

/**
 * The loading surface: the spinner, plus a row and a Cancel for each running
 * hook it covers. `named` adds the workspace to each row, for the startup
 * screen, which stands for every workspace at once.
 */
function loadingConfig(hooks: Array<[number, RunningHook]>, named: boolean): DialogConfig {
  const base = spinnerConfig("Loading workspace...");
  if (hooks.length === 0) return base;
  const label = (hook: RunningHook): string =>
    named ? `${hook.entry} (${hook.workspaceName})` : hook.entry;
  return {
    sections: [
      {
        type: "progress",
        style: "spinner",
        items: [
          { id: "status", label: "Loading workspace...", status: "running" },
          ...hooks.map(([id, hook]) => ({
            id: `hook-${id}`,
            label: `Running ${label(hook)}`,
            status: "running" as const,
          })),
        ],
      },
      {
        type: "group",
        items: hooks.map(([id, hook]) => ({
          type: "button" as const,
          id: `${CANCEL_HOOK_ACTION}${id}`,
          label: hooks.length === 1 ? "Cancel" : `Cancel ${label(hook)}`,
          variant: "secondary" as const,
          title: "Stop the plugin hook. The workspace opens without what it would have set up.",
        })),
      },
    ],
  };
}

/** The panel over an active workspace whose open failed: why, Retry, Delete. */
function openFailedConfig(error: string | undefined): DialogConfig {
  return {
    sections: [
      { type: "text", content: "Could not open workspace", style: "heading" },
      ...(error !== undefined
        ? [{ type: "text" as const, content: error, style: "error" as const }]
        : []),
      {
        type: "group",
        items: [
          { type: "button", id: RETRY_OPEN_ACTION, label: "Retry", variant: "primary" },
          { type: "button", id: DELETE_FAILED_ACTION, label: "Delete", variant: "secondary" },
        ],
      },
    ],
  };
}

/** The first-run setup surface: progress rows, plus Retry/Quit on error. */
function setupConfig(
  rows: readonly SetupRow[],
  error: { message: string } | undefined
): DialogConfig {
  const items: ProgressItem[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    ...(row.message !== undefined && { message: row.message }),
    ...(row.progress !== undefined && { progress: row.progress }),
  }));
  const sections: DialogSection[] = [
    { type: "text", content: "Setting up CodeHydra", style: "heading" },
    { type: "text", content: "This is only required on first startup.", style: "subtitle" },
    { type: "progress", style: "bar", items },
  ];
  if (error !== undefined) {
    sections.push({ type: "text", content: error.message, style: "error" });
    // Retry is primary (Enter activates it); Quit is a plain button; no
    // cancel-role button, so Escape is a no-op (setup is mandatory).
    sections.push({
      type: "group",
      items: [
        // autofocus for the same reason as the agent radio: the persistent
        // dialog doesn't remount when the error + buttons appear.
        { type: "button", id: "retry", label: "Retry", variant: "primary", autofocus: true },
        { type: "button", id: "quit", label: "Quit", variant: "secondary" },
      ],
    });
  }
  return { sections };
}

/**
 * The agent picker: a radio group (defaulting to the first option, focused on
 * mount by the form) + a primary Continue button. Arrow keys move the
 * selection, Enter / Ctrl+Enter activate Continue; no cancel button, so
 * Escape is a no-op (selection is mandatory on first run).
 */
function agentConfig(options: AgentSelectionHookContext["availableAgents"]): DialogConfig {
  return {
    sections: [
      { type: "text", content: "Choose Agent", style: "heading" },
      {
        type: "radio",
        id: "agent",
        // autofocus: the system dialog is one persistent handle updated across
        // phases, so the Form never remounts — the focus-follow moves focus
        // onto the selected radio card when this config replaces the spinner.
        autofocus: true,
        options: options.map((a) => ({ id: a.agent, label: a.label, icon: a.icon })),
      },
      {
        type: "group",
        items: [{ type: "button", id: "continue", label: "Continue", variant: "primary" }],
      },
    ],
  };
}

export interface StartupSurfaceDeps {
  readonly dialogs: Pick<DialogManager, "open">;
  readonly model: PresentationModel;
  readonly runningHooks: Pick<RunningHooks, "openHooks" | "cancel">;
  readonly dispatcher: Pick<IDispatcher, "dispatch">;
  readonly logger: Logger;
  readonly scheduleUpdate: () => void;
  /** Every row in sidebar order (the startup screen ends on the topmost awake one). */
  readonly rows: () => readonly RowEntry[];
  /** Run a failed open again (the failed-open panel's Retry). */
  readonly retryOpen: (workspaceRef: WorkspaceRef) => void;
  /** The interactive remove flow (the failed-open panel's Delete). */
  readonly deleteWorkspace: (workspaceRef: WorkspaceRef) => void;
}

export interface StartupSurface {
  /** Whether startup is over and the normal main logic owns the view. */
  isDone(): boolean;
  /** Whether app:shutdown has started (the system dialog stays closed). */
  isShuttingDown(): boolean;
  /** Open, update or close the system dialog to match the current state. Run on every push. */
  reconcile(): void;
  /** A project:opened arrived (after the model took it in). */
  settleStartupOpen(event: ProjectOpenedEvent | ProjectOpenFailedEvent): void;
  /** Records the startup project:opens the screen waits on. */
  readonly interceptor: IntentInterceptor;
  /** setup:progress, setup:error, app:started, project:open-failed. */
  readonly events: AppEventDeclarations;
  /** app:start hook points: show-ui, agent-selection, await-retry, start. */
  readonly appStartHooks: HooksOf<typeof APP_START_OPERATION_ID>;
  /** app:setup hook points: show-ui, hide-ui. */
  readonly setupHooks: HooksOf<typeof SETUP_OPERATION_ID>;
  /**
   * app:shutdown: keep the system dialog closed for the rest of the process
   * life, and reject any parked startup promises so app:start / app:setup
   * unwind rather than hang.
   */
  shutdown(): void;
}

export function createStartupSurface(deps: StartupSurfaceDeps): StartupSurface {
  const { model, logger, scheduleUpdate } = deps;

  let phase: StartupPhase = "starting";
  /** Accumulated setup row state, keyed by row id (persists across progress). */
  const setupRows = new Map<string, SetupRow>();
  let setupError: { message: string } | undefined;
  /** Available agents for the picker (set by the agent-selection hook). */
  let agentOptions: AgentSelectionHookContext["availableAgents"] = [];
  /**
   * The parked agent-selection hook, while awaiting a pick. A pick resolves it;
   * app:shutdown rejects it so app:setup unwinds WITHOUT reaching save-agent
   * (nothing persisted; next launch re-prompts).
   */
  let agentSelection: PromiseWithResolvers<LifecycleAgentType> | null = null;
  /**
   * app:start's parked await-retry, while awaiting a setup retry. The Retry
   * button resolves it; app:shutdown rejects it to unwind app:start.
   */
  let retry: PromiseWithResolvers<void> | null = null;
  /** The open system dialog, and its kind (immutable per session). */
  let systemDialog: { readonly handle: DialogHandle; readonly kind: DialogKind } | null = null;
  /** Set once app:shutdown starts: the system dialog stays closed thereafter. */
  let shuttingDown = false;
  /** Paths of the startup project:opens that have not announced their workspaces yet. */
  const startupOpens = new Set<string>();
  /** Whether app:ready has dispatched any project:open (none saved: app:started ends it). */
  let startupOpensSeen = false;

  /** Reset the three setup rows to pending (entering the setup phase). */
  function resetSetupRows(): void {
    setupRows.clear();
    setupError = undefined;
    for (const id of SETUP_ROW_IDS) {
      setupRows.set(id, { id, label: SETUP_ROW_LABELS[id] ?? id, status: "pending" });
    }
  }

  /** Current setup rows in canonical (vscode, agent, setup) order. */
  function setupRowList(): SetupRow[] {
    return SETUP_ROW_IDS.map(
      (id) => setupRows.get(id) ?? { id, label: SETUP_ROW_LABELS[id] ?? id, status: "pending" }
    );
  }

  function setPhase(next: StartupPhase): void {
    phase = next;
    scheduleUpdate();
  }

  /** Is this hook for the active workspace? A creating placeholder has its ref already. */
  function belongsToActive(hook: RunningHook): boolean {
    return model.active()?.workspace.ref === hook.workspaceRef;
  }

  /**
   * The desired system-dialog config + kind for the current state, or null for
   * none. All startup-phase surfaces are blocking modals (MainView is unmounted
   * then, so DialogHost must own the screen). The mid-session loading surface is
   * a "panel" instead: MainView is mounted, so blurring/dimming the live sidebar
   * would wrongly read as disabled — the workspace frame is simply not up yet,
   * exactly like the deletion panel masking a torn-down frame. Both render via
   * PanelView, below the sidebar, with no backdrop.
   */
  function computeSystemDialog(): { config: DialogConfig; kind: DialogKind } | null {
    if (shuttingDown) return null;
    switch (phase) {
      case "starting":
        return { config: spinnerConfig("CodeHydra is starting…"), kind: "modal" };
      case "setup":
        return { config: setupConfig(setupRowList(), setupError), kind: "modal" };
      case "agent-selection":
        return { config: agentConfig(agentOptions), kind: "modal" };
      case "running":
        // Until every project has announced its workspaces (see endStartup), a
        // hook of any of them is what the user is waiting on.
        return { config: loadingConfig(deps.runningHooks.openHooks(), true), kind: "modal" };
      case "done": {
        // Mid-session: a still-creating or still-loading active workspace has
        // no frame yet, and one whose open hook is running (a wake) is not
        // usable yet either. One whose open failed says why instead.
        const workspace = model.active()?.workspace;
        if (workspace === undefined) return null;
        if (workspace.phase === "open-failed") {
          return { config: openFailedConfig(workspace.openError), kind: "panel" };
        }
        const hooks = deps.runningHooks.openHooks().filter(([, hook]) => belongsToActive(hook));
        return workspace.phase === "creating" || workspace.phase === "loading" || hooks.length > 0
          ? { config: loadingConfig(hooks, false), kind: "panel" }
          : null;
      }
    }
  }

  /** Route the system dialog's action events (agent pick, Retry, Quit, Cancel). */
  function handleSystemAction(event: DialogActionEvent): void {
    if (event.actionId.startsWith(CANCEL_HOOK_ACTION)) {
      deps.runningHooks.cancel(Number(event.actionId.slice(CANCEL_HOOK_ACTION.length)));
      return;
    }
    switch (event.actionId) {
      case RETRY_OPEN_ACTION: {
        const active = model.active();
        if (active !== undefined) deps.retryOpen(active.workspace.ref);
        return;
      }
      case DELETE_FAILED_ACTION: {
        const active = model.active();
        if (active !== undefined && active.workspace.phase !== "creating") {
          deps.deleteWorkspace(active.workspace.ref);
        }
        return;
      }
      case "continue": {
        const agent = event.data?.["agent"];
        if (agentSelection && agent) {
          logger.info("Agent selected", { agent });
          agentSelection.resolve(agent as LifecycleAgentType);
          agentSelection = null;
        }
        return;
      }
      case "retry":
        if (retry) {
          retry.resolve();
          retry = null;
        }
        return;
      case "quit": {
        const handle = deps.dispatcher.dispatch<AppShutdownIntent>({
          type: INTENT_APP_SHUTDOWN,
          payload: {},
        });
        void handle.catch((error: unknown) => {
          logger.debug("app:shutdown dispatch rejected", { error: getErrorMessage(error) });
        });
        return;
      }
    }
  }

  /**
   * Reconcile the system dialog with the current state. An unchanged config is
   * a no-op (DialogHandle.update skips it), so running this on every push never
   * loops. A kind change (config may be identical, as on the boot "running" →
   * mid-session loading transition) needs close + reopen: kind is immutable.
   */
  function reconcile(): void {
    const desired = computeSystemDialog();
    if (desired === null) {
      systemDialog?.handle.close();
      systemDialog = null;
      return;
    }
    if (systemDialog?.kind === desired.kind) {
      systemDialog.handle.update(desired.config);
      return;
    }
    systemDialog?.handle.close();
    const handle = deps.dialogs.open(desired.config, { kind: desired.kind });
    handle.onEvent(handleSystemAction);
    systemDialog = { handle, kind: desired.kind };
  }

  // ---------------------------------------------------------------------------
  // End of the startup screen
  //
  // app:ready opens every saved project in parallel, and each opens its
  // workspaces one after another — for many workspaces that takes a while. The
  // blocking "Loading workspace..." screen only waits for each project to
  // announce its workspaces (project:opened, emitted before they open) or fail:
  // then the sidebar shows every row, the awake ones loading, and each turns
  // ready as its workspace:created arrives. app:started still ends it at the
  // latest (a project:open that settles without either event).
  // ---------------------------------------------------------------------------

  const interceptor: IntentInterceptor = {
    id: "track-startup-opens",
    before: async (intent: Intent): Promise<Intent | null> => {
      if (!isIntent(intent, INTENT_OPEN_PROJECT) || phase !== "running") return intent;
      const { path } = intent.payload;
      if (path !== undefined) {
        startupOpens.add(path);
        startupOpensSeen = true;
      }
      return intent;
    },
  };

  /** A startup project:open announced its workspaces or failed; the last one ends the screen. */
  function settleStartupOpen(event: ProjectOpenedEvent | ProjectOpenFailedEvent): void {
    const { path } = event.payload;
    if (path === undefined || !startupOpens.delete(path)) return;
    if (startupOpensSeen && startupOpens.size === 0) void endStartup();
  }

  /**
   * Land on the topmost awake row, then hand the main view to the normal
   * logic. Projects announce themselves in whatever order their discovery
   * finishes, and each lands on its first workspace when nothing is active —
   * so the one active now is whichever project was quickest. Every row is
   * known here, which makes the choice the same on every start.
   */
  async function endStartup(): Promise<void> {
    if (phase !== "running") return;
    const top = deps.rows().find((entry) => !entry.workspace.hibernated);
    if (top !== undefined && top.workspace.phase !== "creating" && !top.row.active) {
      try {
        await deps.dispatcher.dispatch<SwitchWorkspaceIntent>({
          type: INTENT_SWITCH_WORKSPACE,
          payload: { workspaceRef: top.workspace.ref },
        });
      } catch (error: unknown) {
        logger.debug("Startup landing switch failed", { error: getErrorMessage(error) });
      }
    }
    // app:started or app:shutdown may have come first.
    if (phase !== "running") return;
    setPhase("done");
  }

  // ---------------------------------------------------------------------------
  // Startup hooks: each just sets the phase + schedules a push; the system
  // dialog is reconciled from that phase in push().
  // ---------------------------------------------------------------------------

  /**
   * app:start `show-ui`: set the boot-splash phase and advertise that this (UI)
   * module can host a setup retry loop. The actual wait happens in the
   * `await-retry` hook below — data in, data out, no closure.
   */
  async function appStartShowUi(): Promise<HookOutput<ShowUIHookResult>> {
    setPhase("starting");
    return { result: { retrySupported: true } };
  }

  /**
   * app:start `agent-selection`: show the picker (a radio system dialog) and park
   * until the user clicks Continue, which arrives as a system-dialog action and
   * resolves the parked promise with the chosen agent (returned as the hook result
   * to app:start). app:shutdown REJECTS the promise so a quit-during-selection throws
   * here — app:start unwinds without reaching save-agent, so no agent is persisted and
   * the next launch re-prompts.
   *
   * On resolve we drop straight back to the boot splash. Leaving the phase on
   * "agent-selection" would keep the (now answered) picker on screen for the whole of
   * check-deps and app:setup — the binary download would run behind a frozen dialog.
   */
  async function appStartAgentSelection(
    ctx: HookInput<typeof APP_START_OPERATION_ID, "agent-selection">
  ): Promise<HookOutput<LifecycleAgentType>> {
    const { availableAgents } = ctx;
    agentOptions = availableAgents;
    setPhase("agent-selection");

    agentSelection = Promise.withResolvers<LifecycleAgentType>();
    const agent = await agentSelection.promise;

    setPhase("starting");
    return { result: agent };
  }

  /**
   * app:start `await-retry`: block until the user clicks Retry (a system-dialog
   * action resolves `retry`), then return. app:shutdown rejects the parked
   * promise so a quit-during-retry unwinds app:start instead of hanging. The promise
   * is module-internal state; nothing crosses the hook contract but the returned void.
   */
  async function awaitRetry(): Promise<void> {
    retry = Promise.withResolvers<void>();
    await retry.promise;
  }

  return {
    isDone: () => phase === "done",
    isShuttingDown: () => shuttingDown,
    reconcile,
    settleStartupOpen,
    interceptor,
    events: {
      [EVENT_PROJECT_OPEN_FAILED]: {
        handler: async (event): Promise<void> => {
          settleStartupOpen(event);
        },
      },
      [EVENT_SETUP_PROGRESS]: {
        handler: async (event): Promise<void> => {
          const row = event.payload;
          // Map SetupRowStatus ("failed") → SetupRow status ("error").
          const status: SetupRow["status"] = row.status === "failed" ? "error" : row.status;
          setupRows.set(row.id, {
            id: row.id,
            label: SETUP_ROW_LABELS[row.id] ?? row.id,
            status,
            ...(row.message !== undefined && { message: row.message }),
            ...(row.progress !== undefined && { progress: row.progress }),
          });
          scheduleUpdate();
        },
      },
      [EVENT_SETUP_ERROR]: {
        handler: async (event): Promise<void> => {
          const { message } = event.payload;
          setupError = { message };
          scheduleUpdate();
        },
      },
      [EVENT_APP_STARTED]: {
        handler: async (): Promise<void> => {
          // Startup is over: hand the main view back to the normal logic. Theme
          // is already seeded + tracked from the app:start `init` hook (so the
          // startup screens carry the right theme), nothing to do here for it.
          setPhase("done");
        },
      },
    },
    appStartHooks: {
      "show-ui": { handler: appStartShowUi },
      "agent-selection": { handler: appStartAgentSelection },
      "await-retry": { handler: awaitRetry },
      start: {
        // Gate on the IDE server: the operation dispatches app:ready (→ project:open,
        // whose workspace URLs must be servable when the renderer mounts iframes)
        // only after this hook point completes, so advancing the phase here waits
        // for the IDE server too. The app:ready dispatch that loads projects is
        // owned by the app:start operation, so this handler is pure UI state.
        requires: { ideServerPort: ANY_VALUE },
        handler: async (): Promise<void> => {
          setPhase("running");
        },
      },
    },
    setupHooks: {
      // app:setup `show-ui`: enter the setup phase with fresh pending rows.
      "show-ui": {
        handler: async (): Promise<void> => {
          resetSetupRows();
          setPhase("setup");
        },
      },
      // app:setup `hide-ui`: return to the boot-splash phase.
      "hide-ui": {
        handler: async (): Promise<void> => {
          setPhase("starting");
        },
      },
    },
    shutdown() {
      shuttingDown = true;
      // Rejecting the agent-selection promise (rather than resolving a default)
      // is deliberate: a quit-mid-pick must NOT persist an agent the user never
      // chose.
      agentSelection?.reject(new Error("app shutting down during agent selection"));
      agentSelection = null;
      retry?.reject(new Error("app shutting down during setup retry"));
      retry = null;
      systemDialog?.handle.close();
      systemDialog = null;
    },
  };
}
