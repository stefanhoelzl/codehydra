/**
 * The app's operations as one type-level table, and the typed declaration
 * helpers modules write their handlers with.
 *
 * `IntentModule.hooks` / `events` are erased (`HookHandler` takes a bare
 * `HookContext`, an event handler a bare `DomainEvent`) because the dispatcher
 * holds every operation in one registry. Declaring them through `defineHooks` /
 * `defineEvents` instead types each handler from the operation's own schema
 * bundle: a hook handler receives its hook point's `input` context (with the
 * operation's intent) and returns its `result`; an event handler receives the
 * event its type names. A wrong operation id, hook point or event type, or a
 * handler written against another context, fails to compile.
 *
 * Every operation registered in `src/main.ts` has an entry in `Operations`;
 * the event and intent maps are derived from the same entries.
 */

import type { EventOf, HookPointOf, IntentOf, OperationSchemas } from "./lib/operation";
import type { DomainEvent, Intent } from "./lib/types";
import type { IDispatcher } from "./lib/dispatcher";
import {
  eventDeclarer,
  hookDeclarer,
  type HandlerInputOf,
  type HookHandlerFor,
  type OperationHooks,
  type TypedEventDeclarations,
  type TypedHookDeclarations,
} from "./lib/module";
import type {
  GET_LAUNCH_OPTIONS_OPERATION_ID,
  schemas as agentLaunchOptionsSchemas,
} from "./agent-launch-options";
import type {
  AGENT_LIFECYCLE_OPERATION_ID,
  schemas as agentLifecycleSchemas,
} from "./agent-lifecycle";
import type { APP_READY_OPERATION_ID, schemas as appReadySchemas } from "./app-ready";
import type { APP_RESUME_OPERATION_ID, schemas as appResumeSchemas } from "./app-resume";
import type { APP_SHUTDOWN_OPERATION_ID, schemas as appShutdownSchemas } from "./app-shutdown";
import type { APP_START_OPERATION_ID, schemas as appStartSchemas } from "./app-start";
import type {
  CLOSE_NOTIFICATION_OPERATION_ID,
  schemas as closeNotificationSchemas,
} from "./close-notification";
import type { CLOSE_PROJECT_OPERATION_ID, schemas as closeProjectSchemas } from "./close-project";
import type {
  DELETE_WORKSPACE_OPERATION_ID,
  schemas as deleteWorkspaceSchemas,
} from "./delete-workspace";
import type {
  GET_ACTIVE_WORKSPACE_OPERATION_ID,
  schemas as getActiveWorkspaceSchemas,
} from "./get-active-workspace";
import type {
  GET_AGENT_SESSION_OPERATION_ID,
  schemas as getAgentSessionSchemas,
} from "./get-agent-session";
import type { GET_METADATA_OPERATION_ID, schemas as getMetadataSchemas } from "./get-metadata";
import type {
  GET_PROJECT_BASES_OPERATION_ID,
  schemas as getProjectBasesSchemas,
} from "./get-project-bases";
import type {
  GET_WORKSPACE_STATUS_OPERATION_ID,
  schemas as getWorkspaceStatusSchemas,
} from "./get-workspace-status";
import type {
  HIBERNATE_WORKSPACE_OPERATION_ID,
  schemas as hibernateWorkspaceSchemas,
} from "./hibernate-workspace";
import type { LIST_PROJECTS_OPERATION_ID, schemas as listProjectsSchemas } from "./list-projects";
import type { OPEN_PROJECT_OPERATION_ID, schemas as openProjectSchemas } from "./open-project";
import type {
  OPEN_WORKSPACE_OPERATION_ID,
  schemas as openWorkspaceSchemas,
} from "./open-workspace";
import type {
  RESOLVE_PROJECT_OPERATION_ID,
  schemas as resolveProjectSchemas,
} from "./resolve-project";
import type {
  RESOLVE_WORKSPACE_OPERATION_ID,
  schemas as resolveWorkspaceSchemas,
} from "./resolve-workspace";
import type { RESTART_AGENT_OPERATION_ID, schemas as restartAgentSchemas } from "./restart-agent";
import type {
  SEND_AGENT_MESSAGE_OPERATION_ID,
  schemas as sendAgentMessageSchemas,
} from "./send-agent-message";
import type { SET_METADATA_OPERATION_ID, schemas as setMetadataSchemas } from "./set-metadata";
import type {
  SET_SHORTCUT_ACTIVE_OPERATION_ID,
  schemas as setShortcutActiveSchemas,
} from "./set-shortcut-active";
import type { SETUP_OPERATION_ID, schemas as setupSchemas } from "./setup";
import type { SHORTCUT_KEY_OPERATION_ID, schemas as shortcutKeySchemas } from "./shortcut-key";
import type {
  SHOW_NOTIFICATION_OPERATION_ID,
  schemas as showNotificationSchemas,
} from "./show-notification";
import type {
  SUBMIT_BUG_REPORT_OPERATION_ID,
  schemas as submitBugReportSchemas,
} from "./submit-bug-report";
import type {
  SWITCH_WORKSPACE_OPERATION_ID,
  schemas as switchWorkspaceSchemas,
} from "./switch-workspace";
import type {
  UPDATE_AGENT_STATUS_OPERATION_ID,
  schemas as updateAgentStatusSchemas,
} from "./update-agent-status";
import type {
  VSCODE_COMMAND_OPERATION_ID,
  schemas as vscodeCommandSchemas,
} from "./vscode-command";
import type {
  VSCODE_MODAL_CHANGED_OPERATION_ID,
  schemas as vscodeModalChangedSchemas,
} from "./vscode-modal-changed";
import type {
  VSCODE_SHOW_MESSAGE_OPERATION_ID,
  schemas as vscodeShowMessageSchemas,
} from "./vscode-show-message";
import type {
  WAKE_WORKSPACE_OPERATION_ID,
  schemas as wakeWorkspaceSchemas,
} from "./wake-workspace";

/** One operation: the id its hooks are registered under, and its schema bundle. */
interface Entry<Id extends string, S extends OperationSchemas> {
  readonly id: Id;
  readonly schemas: S;
}

/** Every operation the app registers. Add a new operation here. */
type Operations =
  | Entry<typeof GET_LAUNCH_OPTIONS_OPERATION_ID, typeof agentLaunchOptionsSchemas>
  | Entry<typeof AGENT_LIFECYCLE_OPERATION_ID, typeof agentLifecycleSchemas>
  | Entry<typeof APP_READY_OPERATION_ID, typeof appReadySchemas>
  | Entry<typeof APP_RESUME_OPERATION_ID, typeof appResumeSchemas>
  | Entry<typeof APP_SHUTDOWN_OPERATION_ID, typeof appShutdownSchemas>
  | Entry<typeof APP_START_OPERATION_ID, typeof appStartSchemas>
  | Entry<typeof CLOSE_NOTIFICATION_OPERATION_ID, typeof closeNotificationSchemas>
  | Entry<typeof CLOSE_PROJECT_OPERATION_ID, typeof closeProjectSchemas>
  | Entry<typeof DELETE_WORKSPACE_OPERATION_ID, typeof deleteWorkspaceSchemas>
  | Entry<typeof GET_ACTIVE_WORKSPACE_OPERATION_ID, typeof getActiveWorkspaceSchemas>
  | Entry<typeof GET_AGENT_SESSION_OPERATION_ID, typeof getAgentSessionSchemas>
  | Entry<typeof GET_METADATA_OPERATION_ID, typeof getMetadataSchemas>
  | Entry<typeof GET_PROJECT_BASES_OPERATION_ID, typeof getProjectBasesSchemas>
  | Entry<typeof GET_WORKSPACE_STATUS_OPERATION_ID, typeof getWorkspaceStatusSchemas>
  | Entry<typeof HIBERNATE_WORKSPACE_OPERATION_ID, typeof hibernateWorkspaceSchemas>
  | Entry<typeof LIST_PROJECTS_OPERATION_ID, typeof listProjectsSchemas>
  | Entry<typeof OPEN_PROJECT_OPERATION_ID, typeof openProjectSchemas>
  | Entry<typeof OPEN_WORKSPACE_OPERATION_ID, typeof openWorkspaceSchemas>
  | Entry<typeof RESOLVE_PROJECT_OPERATION_ID, typeof resolveProjectSchemas>
  | Entry<typeof RESOLVE_WORKSPACE_OPERATION_ID, typeof resolveWorkspaceSchemas>
  | Entry<typeof RESTART_AGENT_OPERATION_ID, typeof restartAgentSchemas>
  | Entry<typeof SEND_AGENT_MESSAGE_OPERATION_ID, typeof sendAgentMessageSchemas>
  | Entry<typeof SET_METADATA_OPERATION_ID, typeof setMetadataSchemas>
  | Entry<typeof SET_SHORTCUT_ACTIVE_OPERATION_ID, typeof setShortcutActiveSchemas>
  | Entry<typeof SETUP_OPERATION_ID, typeof setupSchemas>
  | Entry<typeof SHORTCUT_KEY_OPERATION_ID, typeof shortcutKeySchemas>
  | Entry<typeof SHOW_NOTIFICATION_OPERATION_ID, typeof showNotificationSchemas>
  | Entry<typeof SUBMIT_BUG_REPORT_OPERATION_ID, typeof submitBugReportSchemas>
  | Entry<typeof SWITCH_WORKSPACE_OPERATION_ID, typeof switchWorkspaceSchemas>
  | Entry<typeof UPDATE_AGENT_STATUS_OPERATION_ID, typeof updateAgentStatusSchemas>
  | Entry<typeof VSCODE_COMMAND_OPERATION_ID, typeof vscodeCommandSchemas>
  | Entry<typeof VSCODE_MODAL_CHANGED_OPERATION_ID, typeof vscodeModalChangedSchemas>
  | Entry<typeof VSCODE_SHOW_MESSAGE_OPERATION_ID, typeof vscodeShowMessageSchemas>
  | Entry<typeof WAKE_WORKSPACE_OPERATION_ID, typeof wakeWorkspaceSchemas>;

/** Operation id → schema bundle. */
export type OperationSchemaMap = { readonly [E in Operations as E["id"]]: E["schemas"] };

/**
 * The context a handler for hook point `K` of operation `Id` receives — for a handler
 * written as a named function outside `defineHooks`, where nothing infers it:
 * `async function confirm(ctx: HookInput<typeof DELETE_WORKSPACE_OPERATION_ID, "confirm">)`.
 */
export type HookInput<
  Id extends keyof OperationSchemaMap,
  K extends HookPointOf<OperationSchemaMap[Id]>,
> = HandlerInputOf<OperationSchemaMap[Id], K>;

/** A typed handler (`{ handler, requires }`) for hook point `K` of operation `Id`, built apart. */
export type HookHandlerOf<
  Id extends keyof OperationSchemaMap,
  K extends HookPointOf<OperationSchemaMap[Id]>,
> = HookHandlerFor<OperationSchemaMap[Id], K>;

/**
 * One operation's typed hook handlers (hookPointId → handler), for a part of a module built
 * apart from its `defineHooks` call and spread into it there.
 */
export type HooksOf<Id extends keyof OperationSchemaMap> = OperationHooks<OperationSchemaMap[Id]>;

/** The event of type `T`, for a handler written as a named function outside `defineEvents`. */
export type EventFor<T extends keyof DomainEventMap> = DomainEventMap[T];

/**
 * Every domain event an operation declares, as emitted (type literal + payload). Bundles
 * that declare no events are skipped: `EventOf` widens those to the open `DomainEvent`.
 */
export type AppDomainEvent = DeclaredEventOf<Operations["schemas"]>;
type DeclaredEventOf<S extends OperationSchemas> = S extends { readonly events: object }
  ? EventOf<S>
  : never;

/** Event type → event, from every operation's declared `events`. */
export type DomainEventMap = { readonly [E in AppDomainEvent as E["type"]]: E };

/** Intent type → intent, from every operation's `type` + `payload`. */
export type IntentMap = {
  readonly [S in Operations["schemas"] as S["type"]]: IntentOf<S>;
};

/**
 * Declare a module's hook handlers: operationId → hookPointId → `{ handler, requires }`.
 * Identity at runtime; each handler's context and result are typed from its hook point.
 */
export const defineHooks = hookDeclarer<OperationSchemaMap>();

/** Typed hook contributions across operations, for a part of a module built apart from its `defineHooks` call. */
export type AppHookDeclarations = TypedHookDeclarations<OperationSchemaMap>;

/** Typed event subscriptions, for a part of a module built apart from its `defineEvents` call. */
export type AppEventDeclarations = TypedEventDeclarations<DomainEventMap>;

/**
 * Declare a module's event subscriptions: eventType → `{ handler, requires }`.
 * Identity at runtime; each handler receives its own event type.
 */
export const defineEvents = eventDeclarer<DomainEventMap>();

/**
 * `dispatcher.subscribe` typed by event type: the handler receives that event's own type.
 * Returns the unsubscribe function.
 */
export function subscribe<T extends keyof DomainEventMap>(
  dispatcher: Pick<IDispatcher, "subscribe">,
  type: T,
  handler: (event: DomainEventMap[T]) => void
): () => void {
  // The dispatcher hands a subscriber only events of `type`, validated against that type's
  // payload schema at emit — the same widening `eventDeclarer` does.
  return dispatcher.subscribe(type, handler as (event: DomainEvent) => void);
}

/**
 * Narrow an intent by its type — for interceptors, which see every dispatch.
 * Sound as far as the type literal goes: one operation owns each intent type.
 */
export function isIntent<T extends keyof IntentMap>(
  intent: Intent,
  type: T
): intent is IntentMap[T] {
  return intent.type === type;
}
