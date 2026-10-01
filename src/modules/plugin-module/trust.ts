/**
 * Whether a plugin may run: one state per plugin — enabled, disabled, or ask.
 *
 * Local plugins are the user's own (they put them in `~/.codehydra/plugins`),
 * so they start enabled. Workspace plugins are code from a repository, and the
 * escalation worth defending against is the one that needs no carelessness:
 * `ch ws switch <git-url>` clones a repository and opens it, so without a gate,
 * code from something nobody has ever looked at runs the moment a workspace
 * appears. They start at `ask`.
 *
 * The question is asked at the moment a plugin would actually run, not at
 * project open — a repository with no plugins never raises it, and when it does
 * the question arrives with context. One dialog per project lists every plugin
 * still at `ask`, each with a checkbox:
 *
 * - **Remember** stores checked as enabled and unchecked as disabled;
 * - **Just this time** runs the checked ones now and stores nothing.
 *
 * A plugin the repository adds later is at `ask` again, so the dialog comes
 * back for it alone. `ch plugin enable|disable` sets the same state.
 *
 * It is asked for every dispatch, whatever its source. There is always a window
 * to show it in, and the alternative — skipping silently when the caller is the
 * CLI — would mean a repository's deletion gate could be walked past by typing
 * `ch ws delete`.
 *
 * Stored in state.json as `plugins.state`: `local:<name>` for a local plugin,
 * `workspace:<projectRef>:<name>` for a repository's. The per-project answers
 * of the hooks that came before plugins (`hooks.trusted`) still count: a
 * workspace plugin with no answer of its own takes its project's.
 */

import type {
  DeprecatedPersistedAccessor,
  PersistedAccessor,
} from "../../boundaries/platform/store-definition";
import type { DialogConfig, DialogSection } from "../../shared/dialog-types";
import type { DialogHandle } from "../presentation/sessions";
import type { Logger } from "../../boundaries/platform/logging-types";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import type { ProjectRef, WorkspaceRef } from "../../intents/contract";
import { isRef } from "../../utils/ref";
import type { PluginOrigin } from "./discovery";

// =============================================================================
// Types
// =============================================================================

export type EnabledState = "enabled" | "disabled" | "ask";

/** The subset of the presenter the gate needs. */
export interface TrustDialogOpener {
  dialog(
    config: DialogConfig,
    options?: {
      kind?: "modal" | "modeless" | "panel";
      workspaceRef?: WorkspaceRef;
    }
  ): DialogHandle;
}

export interface PluginTrustDeps {
  readonly enabled: PersistedAccessor<Record<string, boolean>>;
  /** The per-project answers stored before plugins existed. */
  readonly legacyTrusted: Pick<DeprecatedPersistedAccessor, "get">;
  readonly ui: TrustDialogOpener;
  readonly logger: Logger;
}

/** A project, as trust needs it: its ref for the answers, its path for the pre-plugin ones. */
export interface TrustProject {
  readonly ref: ProjectRef;
  readonly path: string;
}

export interface TrustRequest {
  readonly project: TrustProject;
  readonly workspaceRef: WorkspaceRef;
  /** The workspace plugins about to run, by name. */
  readonly plugins: readonly string[];
}

export interface PluginTrust {
  /** A plugin's current state. `project` is required for a workspace plugin. */
  state(origin: PluginOrigin, name: string, project?: TrustProject): EnabledState;
  /** Set a plugin's state; `ask` forgets the stored answer. */
  set(origin: PluginOrigin, name: string, state: EnabledState, project?: ProjectRef): Promise<void>;
  /**
   * Which of a project's workspace plugins may run now: the enabled ones, plus
   * whatever the user allows when asked about those at `ask`.
   */
  check(request: TrustRequest): Promise<ReadonlySet<string>>;
  /**
   * Rename the answers stored by project path, as versions before refs did, to
   * their project's ref. An answer whose project is unknown keeps its key and
   * is never read again: its project asks afresh.
   */
  migrateKeys(refsByPath: ReadonlyMap<string, ProjectRef>): Promise<void>;
}

// =============================================================================
// Keys
// =============================================================================

/** The state.json key of one plugin's answer. */
export function trustKey(origin: PluginOrigin, name: string, project?: ProjectRef): string {
  if (origin === "local") return `local:${name}`;
  if (project === undefined) throw new Error("A workspace plugin's trust needs its project");
  return `workspace:${project}:${name}`;
}

/** The project in a workspace key; names never contain `:`, refs and paths may. */
function projectOfKey(key: string): { project: string; name: string } | undefined {
  if (!key.startsWith("workspace:")) return undefined;
  const rest = key.slice("workspace:".length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0) return undefined;
  return { project: rest.slice(0, cut), name: rest.slice(cut + 1) };
}

// =============================================================================
// Dialog
// =============================================================================

const ACTION_REMEMBER = "remember";
const ACTION_ONCE = "once";
const FIELD_PREFIX = "plugin:";

function buildDialog(repoName: string, plugins: readonly string[]): DialogConfig {
  const sections: DialogSection[] = [
    { type: "text", content: "Run this repository's plugins?", style: "heading" },
    {
      type: "text",
      content:
        `"${repoName}" ships CodeHydra plugins. Running them executes scripts from the ` +
        `repository on your machine.`,
    },
    ...plugins.map((name): DialogSection => ({
      type: "checkbox",
      id: `${FIELD_PREFIX}${name}`,
      label: name,
      value: true,
    })),
    {
      type: "group",
      // Declaration order is tab order; `reverse` puts the primary on the right
      // where a dialog footer's primary belongs.
      reverse: true,
      items: [
        { type: "button", id: ACTION_REMEMBER, label: "Remember", variant: "primary" },
        { type: "button", id: ACTION_ONCE, label: "Just this time", variant: "secondary" },
      ],
    },
  ];
  return { sections, needsAttention: true };
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  return segments.at(-1) ?? path;
}

// =============================================================================
// Gate
// =============================================================================

export function createPluginTrust(deps: PluginTrustDeps): PluginTrust {
  /**
   * One question per project at a time. A plugin with a setup hook and a
   * deletion hook, or an event firing while the user thinks, must not stack
   * dialogs: later requests wait, then reuse the answer for the plugins it
   * covered — a "just this time" included — and ask only about the rest.
   */
  const asking = new Map<string, Promise<ReadonlyMap<string, boolean>>>();

  function stored(): Record<string, boolean> {
    return deps.enabled.get() ?? {};
  }

  function legacyAnswer(projectPath: string): boolean | undefined {
    const legacy = deps.legacyTrusted.get();
    if (typeof legacy !== "object" || legacy === null) return undefined;
    const target = new Path(projectPath);
    for (const [path, value] of Object.entries(legacy as Record<string, unknown>)) {
      if (typeof value === "boolean" && target.equals(path)) return value;
    }
    return undefined;
  }

  function state(origin: PluginOrigin, name: string, project?: TrustProject): EnabledState {
    const answer = stored()[trustKey(origin, name, project?.ref)];
    if (answer !== undefined) return answer ? "enabled" : "disabled";
    if (origin === "local") return "enabled";
    const legacy = project === undefined ? undefined : legacyAnswer(project.path);
    if (legacy !== undefined) return legacy ? "enabled" : "disabled";
    return "ask";
  }

  async function persist(changes: Record<string, boolean | undefined>): Promise<void> {
    const next = { ...stored() };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    try {
      await deps.enabled.set(next);
    } catch (error) {
      // A durable answer we failed to store costs one more question next time,
      // which is a far better outcome than failing the operation over it.
      deps.logger.warn("Could not store a plugin's enabled state", {
        error: getErrorMessage(error),
      });
    }
  }

  async function ask(
    request: TrustRequest,
    plugins: readonly string[]
  ): Promise<ReadonlyMap<string, boolean>> {
    const handle = deps.ui.dialog(buildDialog(basename(request.project.path), plugins), {
      kind: "modal",
      // The first question usually comes from after-worktree-created, while the
      // row is still a placeholder; it has its ref already.
      workspaceRef: request.workspaceRef,
    });

    try {
      const event = await handle.nextEvent();
      const answers = new Map<string, boolean>();
      if (event.kind === "dismiss") {
        for (const name of plugins) answers.set(name, false);
        return answers;
      }
      for (const name of plugins) {
        answers.set(name, event.data?.[`${FIELD_PREFIX}${name}`] !== "false");
      }
      if (event.actionId === ACTION_REMEMBER) {
        await persist(
          Object.fromEntries(
            plugins.map((name) => [
              trustKey("workspace", name, request.project.ref),
              answers.get(name) === true,
            ])
          )
        );
      }
      return answers;
    } finally {
      handle.close();
    }
  }

  async function check(request: TrustRequest): Promise<ReadonlySet<string>> {
    const allowed = new Set<string>();
    let pending: string[] = [];
    for (const name of request.plugins) {
      const current = state("workspace", name, request.project);
      if (current === "enabled") allowed.add(name);
      else if (current === "ask") pending.push(name);
    }

    const projectKey = request.project.ref;
    while (pending.length > 0) {
      const inFlight = asking.get(projectKey);
      if (inFlight !== undefined) {
        const answers = await inFlight;
        const rest: string[] = [];
        for (const name of pending) {
          const answer = answers.get(name);
          if (answer === undefined) {
            // Not in that question: maybe answered durably meanwhile, else ask.
            const current = state("workspace", name, request.project);
            if (current === "enabled") allowed.add(name);
            else if (current === "ask") rest.push(name);
          } else if (answer) {
            allowed.add(name);
          }
        }
        pending = rest;
        continue;
      }

      const question = ask(request, pending).finally(() => asking.delete(projectKey));
      asking.set(projectKey, question);
      const answers = await question;
      for (const name of pending) if (answers.get(name) === true) allowed.add(name);
      pending = [];
    }
    return allowed;
  }

  return {
    state,
    async set(origin, name, next, project) {
      await persist({
        [trustKey(origin, name, project)]: next === "ask" ? undefined : next === "enabled",
      });
    },
    check,
    async migrateKeys(refsByPath) {
      const current = stored();
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(current)) {
        const parsed = projectOfKey(key);
        const ref =
          parsed === undefined || isRef(parsed.project) ? undefined : refOf(parsed.project);
        if (ref !== undefined && parsed !== undefined) {
          changed = true;
          next[trustKey("workspace", parsed.name, ref)] = value;
        } else {
          next[key] = value;
        }
      }
      if (changed) await deps.enabled.set(next);

      function refOf(path: string): ProjectRef | undefined {
        try {
          return refsByPath.get(new Path(path).toString());
        } catch {
          return undefined;
        }
      }
    },
  };
}
