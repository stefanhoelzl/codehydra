/**
 * Whether a repository's hooks may run on this machine.
 *
 * Hooks are code from a repository, and the escalation worth defending against
 * is the one that needs no carelessness: `ch ws switch <git-url>` clones a
 * repository and opens it, so without a gate, code from something nobody has
 * ever looked at runs the moment a workspace appears.
 *
 * The question is asked at the moment a hook would actually fire, not at
 * project open — a repository with no hooks never raises it, and when it does
 * the question arrives with real context. Four answers, because "yes" and "no"
 * both come in a durable and a just-this-once flavour: Always and Never persist
 * per project in state.json; Once and Skip apply to this execution alone.
 *
 * It is asked for every dispatch, whatever its source. There is always a window
 * to show it in, it is at most one interruption per project, and the
 * alternative — skipping silently when the caller is the CLI — would mean a
 * repository's deletion gate could be walked past by typing `ch ws delete`.
 * A timer-driven `auto-workspace` poll simply waits out that cycle.
 */

import type { PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { DialogConfig, DialogSection } from "../../shared/dialog-types";
import type { DialogHandle } from "../presentation/sessions";
import type { Logger } from "../../boundaries/platform/logging-types";

// =============================================================================
// Types
// =============================================================================

/** What the gate decided for one execution. */
export type TrustDecision = "run" | "skip";

/** The subset of the presenter the gate needs. */
export interface TrustDialogOpener {
  dialog(
    config: DialogConfig,
    options?: { kind?: "modal" | "modeless" | "panel"; workspacePath?: string }
  ): DialogHandle;
}

export interface TrustGateDeps {
  readonly trusted: PersistedAccessor<Record<string, boolean>>;
  readonly ui: TrustDialogOpener;
  readonly logger: Logger;
}

export interface TrustRequest {
  readonly projectPath: string;
  readonly workspacePath: string;
  /** On-disk entry name, so the question says what is about to run. */
  readonly entry: string;
}

export interface TrustGate {
  check(request: TrustRequest): Promise<TrustDecision>;
}

// =============================================================================
// Dialog
// =============================================================================

const ACTION_ALWAYS = "always";
const ACTION_ONCE = "once";
const ACTION_SKIP = "skip";
const ACTION_NEVER = "never";

function buildTrustConfig(request: TrustRequest, repoName: string): DialogConfig {
  const sections: DialogSection[] = [
    { type: "text", content: "Run repository hooks?", style: "heading" },
    {
      type: "text",
      content:
        `"${repoName}" defines CodeHydra hooks. Running them executes scripts from ` +
        `the repository on your machine.`,
    },
    {
      type: "text",
      content: `.codehydra/hooks/${request.entry}`,
      style: "subtitle",
    },
    {
      type: "group",
      // Declaration order is tab order; `reverse` puts the primary on the right
      // where a dialog footer's primary belongs.
      reverse: true,
      items: [
        { type: "button", id: ACTION_ALWAYS, label: "Always", variant: "primary" },
        { type: "button", id: ACTION_ONCE, label: "Once", variant: "secondary" },
        {
          type: "button",
          id: ACTION_SKIP,
          label: "Skip",
          variant: "secondary",
          // Escape means "not now", the reversible answer — never the durable
          // refusal, which the user must actually choose.
          role: "cancel",
        },
        { type: "button", id: ACTION_NEVER, label: "Never", variant: "secondary" },
      ],
    },
  ];

  return { sections, needsAttention: true };
}

// =============================================================================
// Gate
// =============================================================================

export function createTrustGate(deps: TrustGateDeps): TrustGate {
  /**
   * One in-flight question per project. A repository with a setup hook and a
   * deletion hook, or an event firing while the user thinks, must not stack
   * dialogs — every waiter resolves on the single answer.
   */
  const asking = new Map<string, Promise<TrustDecision>>();

  /** The stored answers, tolerating a store that has nothing for the key yet. */
  function current(): Record<string, boolean> {
    return deps.trusted.get() ?? {};
  }

  async function persist(projectPath: string, value: boolean): Promise<void> {
    try {
      await deps.trusted.set({ ...current(), [projectPath]: value });
    } catch (error) {
      // A durable answer we failed to store costs one more question next time,
      // which is a far better outcome than failing the operation over it.
      deps.logger.warn("Could not persist the hook trust decision", {
        projectPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ask(request: TrustRequest): Promise<TrustDecision> {
    const repoName = basename(request.projectPath);
    const handle = deps.ui.dialog(buildTrustConfig(request, repoName), {
      kind: "modal",
      workspacePath: request.workspacePath,
    });

    try {
      const event = await handle.nextEvent();
      const action = event.kind === "dismiss" ? ACTION_SKIP : event.actionId;

      switch (action) {
        case ACTION_ALWAYS:
          await persist(request.projectPath, true);
          return "run";
        case ACTION_NEVER:
          await persist(request.projectPath, false);
          return "skip";
        case ACTION_ONCE:
          return "run";
        default:
          return "skip";
      }
    } finally {
      handle.close();
    }
  }

  return {
    async check(request: TrustRequest): Promise<TrustDecision> {
      const persisted = current()[request.projectPath];
      if (persisted !== undefined) {
        return persisted ? "run" : "skip";
      }

      const inFlight = asking.get(request.projectPath);
      if (inFlight) return inFlight;

      const pending = ask(request).finally(() => {
        asking.delete(request.projectPath);
      });
      asking.set(request.projectPath, pending);
      return pending;
    },
  };
}

/** Last path segment, for naming the repository in the question. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  return segments.at(-1) ?? path;
}
