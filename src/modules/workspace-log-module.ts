/**
 * WorkspaceLogModule — a workspace's own log lines in its IDE's Output panel.
 *
 * Every line whose scope names a workspace — the target of the dispatch it was
 * written for, or a `logger.scoped({ path })` / `({ workspace })` inside it — is forwarded to a
 * "CodeHydra Log" channel in that workspace's IDE: what CodeHydra did for this
 * workspace, where the person looking at it already is.
 *
 * - Lines are tapped by `Logging.onLine`, before the file's level and logger
 *   filters: everything at debug and up is sent, and the channel (a VS Code
 *   `LogOutputChannel`) drops what is below the level the user set on it.
 *   `silly` is never sent — it carries unbounded payloads.
 * - A line names its workspace by `project/ws`, which is reached by its ref
 *   once the workspace has opened (`workspace:created`). Lines from before that
 *   (a creation logs throughout its open) are held by name and follow.
 * - Held and batched by `createWorkspaceOutput`: bounded while the IDE is away,
 *   flushed on connect, dropped when the workspace is deleted.
 *
 * The listener never logs: its own lines would be forwarded, and come back.
 */

import { projectNameOf } from "../utils/ref";
import type { ProjectRef, WorkspaceRef } from "../intents/contract";
import { formatContext, formatLogScope } from "../boundaries/platform/log-scope";
import type { Logger, Logging, LogLine, LogScope } from "../boundaries/platform/logging-types";
import type { OutputLine, OutputLineLevel } from "../shared/api-protocol";
import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import { EVENT_WORKSPACE_DELETED, type WorkspaceDeletedEvent } from "../intents/delete-workspace";
import {
  EVENT_WORKSPACE_CREATE_FAILED,
  EVENT_WORKSPACE_CREATED,
  INTENT_OPEN_WORKSPACE,
  type WorkspaceCreateFailedEvent,
  type WorkspaceCreatedEvent,
} from "../intents/open-workspace";
import { createWorkspaceOutput, type OutputTransport } from "./workspace-output";

/** The channel a workspace's log lines appear in. */
export const WORKSPACE_LOG_CHANNEL = "CodeHydra Log";

/**
 * Most lines held for one workspace while its IDE is away — enough for a
 * creation at debug (git, agent setup, hooks) plus a few quiet minutes.
 */
const MAX_BUFFERED_LINES = 1000;

const OUTPUT_LEVELS: Readonly<Record<Exclude<LogLine["level"], "silly">, OutputLineLevel>> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

export interface WorkspaceLogModuleDeps {
  readonly logging: Pick<Logging, "onLine">;
  readonly transport: OutputTransport;
  /** For the module's own rare line (a flush that failed). */
  readonly logger: Logger;
}

/** How a line reads in the channel: its workspace is the channel's, so the block leaves it out. */
export function formatWorkspaceLogLine(line: LogLine): string {
  const scope: LogScope = line.scope ?? {};
  const withoutWorkspace = Object.fromEntries(
    Object.entries(scope).filter(([key]) => key !== "project" && key !== "ws" && key !== "path")
  ) as LogScope;
  return [
    `(${line.logger})`,
    formatLogScope(withoutWorkspace),
    line.message,
    formatContext(line.context),
    line.error ? `error=${line.error.message}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

export function createWorkspaceLogModule(deps: WorkspaceLogModuleDeps): {
  readonly module: IntentModule;
  readonly dispose: () => void;
} {
  const output = createWorkspaceOutput({
    transport: deps.transport,
    channel: WORKSPACE_LOG_CHANNEL,
    log: true,
    maxBuffered: MAX_BUFFERED_LINES,
    batch: true,
    logger: deps.logger,
  });
  /**
   * `project/ws` → its ref, learned when the workspace opens. A line names its
   * workspace as `project/ws`, which is the project's name (`projectNameOf`) and
   * the workspace's.
   */
  const refs = new Map<string, WorkspaceRef>();
  /** Lines of a workspace not open yet, by `project/ws`. */
  const unbound = new Map<string, OutputLine[]>();

  const keyOf = (project: string, ws: string): string => `${project}/${ws}`;
  const keyOfRef = (projectRef: ProjectRef, ws: string): string =>
    keyOf(projectNameOf(projectRef), ws);

  const unsubscribe = deps.logging.onLine((line) => {
    if (line.level === "silly") return;
    const scope = line.scope;
    if (scope?.project === undefined || scope.ws === undefined) return;
    const key = keyOf(scope.project, scope.ws);
    const entry: OutputLine = {
      source: line.logger,
      level: OUTPUT_LEVELS[line.level],
      text: formatWorkspaceLogLine(line),
    };

    const ref = refs.get(key);
    if (ref === undefined) {
      const held = unbound.get(key) ?? [];
      held.push(entry);
      if (held.length > MAX_BUFFERED_LINES) held.splice(0, held.length - MAX_BUFFERED_LINES);
      unbound.set(key, held);
      return;
    }
    // An open brings a closed workspace's editor back: worth holding for again.
    if (scope.intent === INTENT_OPEN_WORKSPACE) output.opening(ref);
    output.write(ref, [entry]);
  });

  function forget(key: string): void {
    refs.delete(key);
    unbound.delete(key);
  }

  const module: IntentModule = {
    name: "workspace-log",
    events: {
      [EVENT_WORKSPACE_CREATED]: {
        // The workspace is open: its lines go to its editor from now on, the
        // ones written while it was being opened first.
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspaceRef, projectRef, workspaceName } = (event as WorkspaceCreatedEvent)
            .payload;
          const key = keyOfRef(projectRef, workspaceName);
          refs.set(key, workspaceRef);
          output.opening(workspaceRef);
          const earlier = unbound.get(key);
          if (earlier) {
            unbound.delete(key);
            output.write(workspaceRef, earlier);
          }
        },
      },
      [EVENT_WORKSPACE_DELETED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspaceRef, projectRef, workspaceName } = (event as WorkspaceDeletedEvent)
            .payload;
          output.closed(workspaceRef);
          forget(keyOfRef(projectRef, workspaceName));
        },
      },
      [EVENT_WORKSPACE_CREATE_FAILED]: {
        // A creation that failed: its editor is not coming, so its lines have nowhere to go.
        handler: async (event: DomainEvent): Promise<void> => {
          const { projectRef, workspaceName } = (event as WorkspaceCreateFailedEvent).payload;
          const key = keyOfRef(projectRef, workspaceName);
          const ref = refs.get(key);
          if (ref !== undefined) output.closed(ref);
          forget(key);
        },
      },
    },
  };

  return { module, dispose: unsubscribe };
}
