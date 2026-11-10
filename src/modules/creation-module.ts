/**
 * CreationModule - Backend owner of the "New workspace" creation form.
 *
 * Hosts a declarative Form on a "modeless" dialog (a non-blocking popup on top,
 * above the sidebar — the renderer's PanelView, rendered by MainView in the
 * ground state). The session is always alive: it opens once on app:started and
 * is reset (close + reopen with fresh config = new dialogId) on every dismiss
 * event. The renderer owns visibility (shown while main.kind === "creation")
 * and sends a dismiss both for Escape and when the panel is shown, so a
 * dismiss simply means "give me a fresh form".
 *
 * The form knows no project type. What differs by type comes from the type:
 *
 * - Project row: the add-project buttons modules contribute
 *   (project:list-add-actions — core's folder picker, git's clone), then the
 *   dropdown of open projects. A button runs its module's flow (project:add).
 * - Option fields: the selected project's type's create options
 *   (`ProjectTypeOptions`, from app:start), rendered after Name. A select with
 *   dynamic choices loads in two phases per project selection: the type's fast
 *   answer displays at once (project:get-option-choices with refresh), the
 *   loading spinner stays on until the background refresh confirms via
 *   option-choices:updated. The same answer carries the type's Name
 *   suggestions; picking one sets the options it names (git: its base).
 * - Per-field validation (name format / duplicates, a select without a value)
 *   and Create-button gating, driven by field-change events.
 * - Submit: dispatches workspace:open (source "creation"). The enriched
 *   workspace:loading event drives the renderer's optimistic placeholder;
 *   workspace:create-failed rolls it back. The module just resets the form.
 * - Seeding: the next reset seeds the project from the most recently opened
 *   project (cleared on use and on workspace switch), else the active
 *   workspace's project, else the first open project.
 */

import type { IntentModule } from "../intents/lib/module";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogHandle } from "./presentation/sessions";
import type { UiPresenter } from "./presentation/presentation-module";
import type { DialogConfig, DialogSection, DropdownSuggestionGroup } from "../shared/dialog-types";
import type { Logger } from "../boundaries/platform/logging";
import type { AgentInfo, LifecycleAgentType } from "../shared/ipc";
import type { Project, AgentSpec } from "../shared/api/types";
import { validateWorkspaceName } from "../shared/api/types";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../boundaries/platform/config";
import { getErrorMessage } from "../shared/error-utils";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import { EVENT_PROJECT_OPENED } from "../intents/open-project";
import { EVENT_PROJECT_CLOSED } from "../intents/close-project";
import {
  EVENT_OPTION_CHOICES_UPDATED,
  INTENT_GET_OPTION_CHOICES,
  type FieldChoices,
  type GetOptionChoicesIntent,
  type GetOptionChoicesResult,
  type NameSuggestion,
} from "../intents/get-option-choices";
import {
  INTENT_ADD_PROJECT,
  INTENT_LIST_ADD_ACTIONS,
  type AddProjectAction,
  type AddProjectIntent,
  type ListAddActionsIntent,
} from "../intents/add-project";
import type { OptionField, ProjectTypeOptions } from "../intents/project-type-options";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import {
  INTENT_OPEN_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
} from "../intents/open-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../intents/list-projects";
import {
  INTENT_GET_LAUNCH_OPTIONS,
  type GetLaunchOptionsIntent,
  type LaunchOptionsResult,
} from "../intents/agent-launch-options";
import type { ProjectRef } from "../intents/contract";
import { defineEvents } from "../intents/declarations";

// =============================================================================
// Dependencies
// =============================================================================

export interface CreationModuleDeps {
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly dispatcher: Dispatcher;
  /** Every project type's create options: the fields a selected project's type adds. */
  readonly projectTypes: ProjectTypeOptions;
  /** Global default agent (config.agent). */
  readonly agentConfig: PersistedAccessor<ConfigAgentType>;
  /** Agents whose binaries are currently present (same source as app:ready). */
  readonly getAvailableAgents: () => Promise<readonly AgentInfo[]>;
  readonly logger: Logger;
}

// =============================================================================
// Field / action ids
// =============================================================================

const FIELD_PROJECT = "project";
const FIELD_NAME = "name";
const FIELD_PROMPT = "prompt";
const FIELD_AGENT = "agent";
const FIELD_AGENT_NAME = "agent-name";
const FIELD_PERMISSION_MODE = "permission-mode";
const ACTION_CREATE = "create";
const ACTION_RESET = "reset";

/**
 * Ids the form uses itself. A type's option is a field of its own name (option
 * names are camelCase and the core input's names are reserved, so they cannot
 * meet these); a contributed button with one of these ids is not shown.
 */
const CORE_IDS: ReadonlySet<string> = new Set([
  FIELD_PROJECT,
  FIELD_NAME,
  FIELD_PROMPT,
  FIELD_AGENT,
  FIELD_AGENT_NAME,
  FIELD_PERMISSION_MODE,
  ACTION_CREATE,
  ACTION_RESET,
  "project-placeholder",
]);

// =============================================================================
// Form state
// =============================================================================

/** A select's choices as the form shows them: what the type answered, or none yet. */
const NO_CHOICES: FieldChoices = { choices: [] };

/** What the creation form shows. One per session: a reset starts from `initialForm()`. */
interface FormState {
  /** Backend the form currently targets (drives the per-backend fields). */
  agentType: LifecycleAgentType | null;
  /**
   * Launch options the selected backend reported (via agent:get-launch-options).
   * The form is agent-agnostic: it renders whatever options come back. Re-fetched
   * on every form open / backend switch; the heavy work (e.g. parsing
   * `claude --help`) is cached inside the provider, so re-querying is cheap.
   */
  launchOptions: LaunchOptionsResult | null;
  /** The backend whose launch options are currently being fetched (if any). */
  loadingLaunchOptionsFor: LifecycleAgentType | null;
  projectRef: ProjectRef | null;
  /** The selected project's type's dynamic choices, by option name. */
  choices: Readonly<Record<string, FieldChoices>>;
  /** The type's suggestions for the Name field. */
  nameSuggestions: readonly NameSuggestion[];
  /** Waiting for the type's choices to be confirmed by a refresh. */
  choicesLoading: boolean;
  choicesError: string | null;
  /** Raw name field value (a suggestion's value after a pick). */
  name: string;
  /**
   * The selected project's type's option values, by option name. A checkbox
   * holds "true"/"false", as the dialog reports it.
   */
  options: Record<string, string>;
  /**
   * Prompt / agent-name / permission-mode field values.
   *
   * These are tracked (not just read from the submit snapshot) because the
   * renderer unmounts the panel on every hide, so the module is the only thing
   * that survives a close/reopen. Each is pushed back as a controlled `value`
   * so the remounted Form restores what was typed instead of coming up blank.
   */
  prompt: string;
  agentName: string;
  permissionMode: string;
  /**
   * Whether the user has touched any field since the last reset. Drives the
   * Reset button's enabled state ("as soon as any input was made"). Set from
   * field-change events only, so the seeding openSession() does programmatically
   * (selectProject) never counts as input.
   */
  dirty: boolean;
  /** The add-project action whose flow is running (a picker, a sub-dialog). */
  busyAction: string | null;
  /** Form-level error (e.g. an add-project failure), shown above the footer. */
  error: string | null;
}

function initialForm(): FormState {
  return {
    agentType: null,
    launchOptions: null,
    loadingLaunchOptionsFor: null,
    projectRef: null,
    choices: {},
    nameSuggestions: [],
    choicesLoading: false,
    choicesError: null,
    name: "",
    options: {},
    prompt: "",
    agentName: "",
    permissionMode: "",
    dirty: false,
    busyAction: null,
    error: null,
  };
}

// =============================================================================
// Module
// =============================================================================

/** The creation module, plus the sidebar's project preset (a project card's +). */
export interface CreationModule extends IntentModule {
  /**
   * Preselect the form's project, as the sidebar's per-project + button asks.
   * An explicit choice: it overrides the seed rule and a touched form's
   * project (the rest of what was typed stays). Applied at once and — with
   * `deselecting`, when a switch to the panel is under way — again when that
   * deselect lands, so the follow-the-workspace rule in the workspace:switched
   * handler cannot undo it. Unknown refs are ignored.
   */
  presetProject(projectRef: ProjectRef, deselecting: boolean): void;
  /**
   * Whether the form holds input the user typed or picked since the last
   * reset (Reset, Escape, or a submitted Create). While it does and the form
   * is on screen, nothing but the user moves the view off it.
   */
  isEdited(): boolean;
}

export function createCreationModule(deps: CreationModuleDeps): CreationModule {
  const { ui, dispatcher, logger } = deps;

  // ---- Session state ----

  /** Open projects (id/name/path/workspaces), refreshed via project:list. */
  let projects: readonly Project[] = [];
  /** Agents available at the last session (re)open. */
  let availableAgents: readonly AgentInfo[] = [];
  /** What the form shows; replaced whole when a session (re)opens. */
  let form = initialForm();
  /** Project to seed the next reset with (most recently opened project). */
  let pendingSeedProjectRef: ProjectRef | null = null;
  /**
   * Project path of the workspace the app last made active. Recorded from
   * non-null workspace:switched events so it survives the deselect
   * (workspace:switch → null) the renderer fires when showing the panel —
   * that deselect would otherwise null the live active ref before the seed
   * reads it, collapsing the seed to projects[0].
   */
  let lastActiveProjectRef: ProjectRef | null = null;
  /** A preset (presetProject) the next deselect must re-apply instead of the seed rule. */
  let presetProjectRef: ProjectRef | null = null;
  /** Guards against overlapping resets (dismiss bursts). */
  let resetting = false;
  /** Invalidates in-flight choice fetches when the selection changes. */
  let selectionEpoch = 0;
  /** The add-project buttons modules contribute, fetched at each session open. */
  let addActions: readonly AddProjectAction[] = [];

  let handle: DialogHandle | null = null;
  /** Strips the autofocus flag for one config build (focus re-arm nudge). */
  let suppressAutofocus = false;

  // ---- Derived helpers ----

  function selectedProject(): Project | undefined {
    return projects.find((p) => p.ref === form.projectRef);
  }

  /** The create options the selected project's type shows in the dialog, in declared order. */
  function optionFields(projectRef: ProjectRef | null = form.projectRef): [string, OptionField][] {
    if (projectRef === null) return [];
    const type = deps.projectTypes.typeOf(projectRef);
    return Object.entries(deps.projectTypes.fieldsOf(type, "create")).filter(
      ([, field]) => field.dialog !== false
    );
  }

  /** A select's choices: static from the description, dynamic from the type's answer. */
  function choicesOf(name: string, field: OptionField): FieldChoices {
    if (field.choices === "dynamic") return form.choices[name] ?? NO_CHOICES;
    return { choices: field.choices ?? [] };
  }

  /** Whether a value is one of a select's current choices. */
  function isChoice(name: string, value: string): boolean {
    const field = optionFields().find(([n]) => n === name)?.[1];
    if (field === undefined || field.kind !== "select") return false;
    return choicesOf(name, field).choices.some((choice) => choice.value === value);
  }

  /** A select's value for fresh choices: the type's default when offered, else the first. */
  function pickDefault(choices: FieldChoices): string {
    if (choices.default !== undefined && choices.choices.some((c) => c.value === choices.default)) {
      return choices.default;
    }
    return choices.choices[0]?.value ?? "";
  }

  /** The option values a project's type starts from: its declared defaults. */
  function initialOptions(projectRef: ProjectRef): Record<string, string> {
    const options: Record<string, string> = {};
    for (const [name, field] of optionFields(projectRef)) {
      if (field.kind === "checkbox") options[name] = String(field.default === true);
      else if (typeof field.default === "string") options[name] = field.default;
      else if (field.kind === "select" && field.choices !== "dynamic") {
        options[name] = field.choices?.[0]?.value ?? "";
      } else options[name] = "";
    }
    return options;
  }

  /** The configured global default agent (already validated by the store). */
  function defaultAgent(): LifecycleAgentType | null {
    return deps.agentConfig.get();
  }

  /** Narrow a raw field value to a currently-available agent. */
  function isAvailableAgent(value: string): value is LifecycleAgentType {
    return availableAgents.some((a) => a.agent === value);
  }

  /** Backend to target on a fresh form: configured default, else first available. */
  function resolveInitialAgentType(): LifecycleAgentType | null {
    const configured = defaultAgent();
    if (configured !== null && availableAgents.some((a) => a.agent === configured)) {
      return configured;
    }
    return availableAgents[0]?.agent ?? null;
  }

  /** Permission modes reported by the currently selected backend. */
  function currentPermissionModes(): readonly string[] {
    return form.launchOptions?.permissionModes ?? [];
  }

  /** True while the selected backend's launch options are being fetched. */
  function launchOptionsLoading(): boolean {
    return form.loadingLaunchOptionsFor !== null && form.loadingLaunchOptionsFor === form.agentType;
  }

  /**
   * The permission mode to display, guarded against backend switches: a
   * remembered mode belongs to whichever backend was selected when it was
   * picked, and switching backends (or the options still loading) can leave it
   * unofferable. Anything the current backend does not list collapses to ""
   * — the "default" entry, which omits the flag.
   */
  function currentPermissionMode(): string {
    if (form.permissionMode === "") return "";
    return currentPermissionModes().includes(form.permissionMode) ? form.permissionMode : "";
  }

  /** Permission-mode suggestions: the default entry plus the backend's modes. */
  function permissionModeSuggestions(): DropdownSuggestionGroup[] {
    const items = [
      { value: "", label: "default" },
      ...currentPermissionModes()
        .filter((mode) => mode !== "default")
        .map((mode) => ({ value: mode, label: mode })),
    ];
    return [{ items }];
  }

  /**
   * Fetch the selected backend's launch options. Agent-agnostic: the form just
   * asks the backend what it offers. Called on every form open and backend
   * switch — the provider caches the heavy work, so re-querying is cheap. The
   * stale options are cleared up front so the form never shows another backend's
   * values, and a late response is ignored if the backend changed meanwhile.
   */
  async function loadLaunchOptions(): Promise<void> {
    const backend = form.agentType;
    form.launchOptions = null;
    if (backend === null) {
      pushConfig();
      return;
    }
    form.loadingLaunchOptionsFor = backend;
    pushConfig();
    try {
      const intent: GetLaunchOptionsIntent = {
        type: INTENT_GET_LAUNCH_OPTIONS,
        payload: { backend },
      };
      const result = await dispatcher.dispatch(intent);
      if (form.agentType === backend) form.launchOptions = result;
    } catch (error) {
      logger.warn("Creation form: launch options fetch failed", {
        error: getErrorMessage(error),
      });
    } finally {
      if (form.loadingLaunchOptionsFor === backend) form.loadingLaunchOptionsFor = null;
      pushConfig();
    }
  }

  /**
   * Resolve the raw name field value: a suggestion pick reports the
   * suggestion's unique value while displaying the name it gives — map it back.
   */
  function resolveName(raw: string): string {
    return form.nameSuggestions.find((s) => s.value === raw)?.label ?? raw;
  }

  /** Per-field name error: format violations and duplicates. Empty = no error. */
  function nameError(raw: string): string | null {
    const resolved = resolveName(raw).trim();
    if (resolved === "") return null;
    const formatError = validateWorkspaceName(resolved);
    if (formatError) return formatError;
    const existing = selectedProject()?.workspaces ?? [];
    if (existing.some((w) => w.name.toLowerCase() === resolved.toLowerCase())) {
      return "Workspace already exists";
    }
    return null;
  }

  function isFormValid(): boolean {
    return (
      selectedProject() !== undefined &&
      resolveName(form.name).trim() !== "" &&
      // A select always carries a value; without one there is nothing to create from.
      optionFields().every(
        ([name, field]) => field.kind !== "select" || (form.options[name] ?? "") !== ""
      ) &&
      nameError(form.name) === null &&
      form.busyAction === null
    );
  }

  // ---- Config building ----

  /** Items grouped under their headings, in the order the groups first appear. */
  function grouped(
    items: readonly {
      readonly value: string;
      readonly label?: string | undefined;
      readonly group?: string | undefined;
    }[]
  ): DropdownSuggestionGroup[] {
    const groups: { header?: string; items: { value: string; label: string }[] }[] = [];
    for (const item of items) {
      let group = groups.find((g) => g.header === item.group);
      if (group === undefined) {
        group = item.group === undefined ? { items: [] } : { header: item.group, items: [] };
        groups.push(group);
      }
      group.items.push({ value: item.value, label: item.label ?? item.value });
    }
    return groups;
  }

  /** One of the selected project's type's options, as a form field. */
  function optionSection(name: string, field: OptionField, hasProject: boolean): DialogSection {
    const common = {
      id: name,
      label: field.label ?? name,
      disabled: !hasProject || form.busyAction !== null,
      changeEvent: true,
    } as const;
    const value = form.options[name] ?? "";
    switch (field.kind) {
      case "checkbox":
        return { type: "checkbox", ...common, value: value === "true" };
      case "text":
        return {
          type: "input",
          ...common,
          // Seeded, not controlled — see FIELD_NAME: echoing typed text back races typing.
          initialValue: value,
          ...(field.placeholder !== undefined && { placeholder: field.placeholder }),
        };
      case "select": {
        const dynamic = field.choices === "dynamic";
        const choices = choicesOf(name, field);
        const error = dynamic
          ? (form.choicesError ??
            (!form.choicesLoading && choices.choices.length === 0 ? choices.empty : undefined))
          : undefined;
        return {
          type: "dropdown",
          ...common,
          suggestions: grouped(choices.choices),
          value,
          placeholder: field.placeholder ?? "Select...",
          ...(dynamic && { loading: form.choicesLoading }),
          ...(error !== undefined && { error }),
        };
      }
    }
  }

  function buildConfig(): DialogConfig {
    const hasProject = selectedProject() !== undefined;
    const currentNameError = nameError(form.name);
    const busy = form.busyAction !== null;
    const buttons = addActions.filter((action) => !CORE_IDS.has(action.id));
    const sections: DialogSection[] = [
      { type: "text", content: "New workspace", style: "heading" },
      {
        type: "group",
        label: "Project",
        items: [
          // The contributed buttons lead the row so the tab order matches the
          // visuals: buttons (in module registration order) -> project dropdown.
          ...buttons.map((action, index) => ({
            type: "button" as const,
            id: action.id,
            icon: action.icon,
            title: action.title,
            ...(form.busyAction === action.id ? { busy: true } : { disabled: busy }),
            // Without a project the buttons are the only way forward.
            ...(!hasProject && index === 0 && { autofocus: true }),
          })),
          ...(projects.length > 0
            ? [
                {
                  type: "dropdown" as const,
                  id: FIELD_PROJECT,
                  suggestions: [{ items: projects.map((p) => ({ value: p.ref, label: p.name })) }],
                  value: form.projectRef ?? "",
                  changeEvent: true,
                  disabled: busy,
                },
              ]
            : [
                {
                  type: "input" as const,
                  id: "project-placeholder",
                  placeholder: "Open or add a project",
                  disabled: true,
                },
              ]),
        ],
      },
      {
        type: "dropdown",
        id: FIELD_NAME,
        label: "Name",
        freeText: true,
        suggestions: grouped(form.nameSuggestions),
        // Seeded (not controlled) so a remembered name survives the Form
        // remount the panel does on every show. `initialValue` applies on first
        // sight only and never re-seeds a live field, so echoing the user's own
        // text back can never race their typing — the reason this field was
        // left uncontrolled to begin with.
        initialValue: form.name,
        // A restored name arrives selected, so typing replaces it instead of
        // appending to text the user would have to clear by hand.
        selectInitialValue: true,
        placeholder:
          form.nameSuggestions.length > 0
            ? "Enter name or select a suggestion..."
            : "Enter name...",
        changeEvent: true,
        disabled: !hasProject || busy,
        ...(hasProject && !suppressAutofocus && { autofocus: true }),
        ...(currentNameError !== null && { error: currentNameError }),
      },
      ...optionFields().map(([name, field]) => optionSection(name, field, hasProject)),
      {
        type: "input",
        id: FIELD_PROMPT,
        label: "Prompt",
        multiline: true,
        rows: 3,
        // Seeded, not controlled — see FIELD_NAME above.
        initialValue: form.prompt,
        changeEvent: true,
        placeholder: "Optional prompt — sent as soon as the workspace is ready",
      },
    ];

    if (availableAgents.length > 1) {
      sections.push({
        type: "dropdown",
        id: FIELD_AGENT,
        label: "Agent",
        searchable: false,
        suggestions: [{ items: availableAgents.map((a) => ({ value: a.agent, label: a.label })) }],
        value: form.agentType ?? "",
        changeEvent: true,
      });
    }

    // Named agent/persona — free text for any backend (maps to the backend's
    // named-agent option). Empty reports "" and omits the flag.
    sections.push({
      type: "input",
      id: FIELD_AGENT_NAME,
      label: "Agent name",
      // Seeded, not controlled — see FIELD_NAME above.
      initialValue: form.agentName,
      changeEvent: true,
      placeholder: "default",
    });

    // Permission mode is driven by the backend's reported launch options: shown
    // while loading or when the backend offers any modes, hidden otherwise (the
    // form stays agent-agnostic — it never special-cases a backend). The
    // "default" entry reports "" and omits the flag.
    if (launchOptionsLoading() || currentPermissionModes().length > 0) {
      sections.push({
        type: "dropdown",
        id: FIELD_PERMISSION_MODE,
        label: "Permission mode",
        searchable: false,
        suggestions: permissionModeSuggestions(),
        // Guarded: a remembered mode belongs to whichever backend was selected
        // when it was picked, and the backend can change under it. Anything the
        // current backend does not offer collapses to "" (the "default" entry,
        // which omits the flag) rather than pushing a mode it cannot honour.
        value: currentPermissionMode(),
        changeEvent: true,
        loading: launchOptionsLoading(),
      });
    }

    if (form.error !== null) {
      sections.push({ type: "text", content: form.error, icon: "error" });
    }

    sections.push({
      type: "group",
      align: "right",
      items: [
        // role "cancel" makes Escape and this button the same gesture: Form
        // clicks the first ENABLED cancel-role button, so on a clean form
        // Escape instead falls through to the dismiss path — which lands on the
        // same resetSession(), where re-seeding a form that was never touched
        // is a no-op.
        {
          type: "button",
          id: ACTION_RESET,
          label: "Reset",
          variant: "secondary",
          role: "cancel",
          disabled: !form.dirty,
        },
        {
          type: "button",
          id: ACTION_CREATE,
          label: "Create",
          variant: "primary",
          disabled: !isFormValid(),
        },
      ],
    });

    return { sections, layout: "form" };
  }

  /** Push the current config (the handle skips an unchanged one). */
  function pushConfig(): void {
    handle?.update(buildConfig());
  }

  // ---- Data fetching ----

  async function refreshProjects(): Promise<void> {
    try {
      const intent: ListProjectsIntent = { type: INTENT_LIST_PROJECTS, payload: {} };
      projects = await dispatcher.dispatch(intent);
    } catch (error) {
      logger.warn("Creation form: project list failed", { error: getErrorMessage(error) });
    }
  }

  async function refreshAddActions(): Promise<void> {
    try {
      const intent: ListAddActionsIntent = { type: INTENT_LIST_ADD_ACTIONS, payload: {} };
      addActions = await dispatcher.dispatch(intent);
    } catch (error) {
      logger.warn("Creation form: add-project actions failed", { error: getErrorMessage(error) });
    }
  }

  /** Take a choices answer: dynamic selects re-default to it (all, or only stale ones). */
  function applyChoices(result: GetOptionChoicesResult, keepValid: boolean): void {
    form.choices = result.fields;
    form.nameSuggestions = result.nameSuggestions;
    for (const [name, field] of optionFields()) {
      if (field.kind !== "select" || field.choices !== "dynamic") continue;
      const choices = choicesOf(name, field);
      const current = form.options[name] ?? "";
      if (keepValid && choices.choices.some((c) => c.value === current)) continue;
      form.options[name] = pickDefault(choices);
    }
  }

  /**
   * Select a project: start from its type's option defaults, push the loading
   * state, then fetch the type's choices (its fast answer first; refresh kicks
   * the background refresh whose result arrives via option-choices:updated and
   * turns the spinner off).
   *
   * refocusName re-arms the renderer's autofocus-move detection (a push
   * without the flag, then the regular config) so the name field gets focused
   * even when it already carried the flag — used after an add-project flow.
   */
  function selectProject(projectRef: ProjectRef, options?: { refocusName?: boolean }): void {
    form.projectRef = projectRef;
    form.choices = {};
    form.nameSuggestions = [];
    form.choicesLoading = true;
    form.choicesError = null;
    form.options = initialOptions(projectRef);
    form.error = null;
    const epoch = ++selectionEpoch;
    if (options?.refocusName) {
      suppressAutofocus = true;
      pushConfig();
      suppressAutofocus = false;
    }
    pushConfig();

    const intent: GetOptionChoicesIntent = {
      type: INTENT_GET_OPTION_CHOICES,
      payload: { projectRef, refresh: true },
    };
    dispatcher.dispatch(intent).then(
      (result) => {
        if (epoch !== selectionEpoch) return;
        applyChoices(result, false);
        // Loading stays on until option-choices:updated confirms the fresh list.
        pushConfig();
      },
      (error: unknown) => {
        if (epoch !== selectionEpoch) return;
        form.choicesError = getErrorMessage(error);
        form.choicesLoading = false;
        pushConfig();
      }
    );
  }

  // ---- Session lifecycle ----

  /** Seed rule: pending opened project > last active workspace's project > first. */
  function computeSeedProject(): ProjectRef | null {
    if (pendingSeedProjectRef !== null) {
      const seed = pendingSeedProjectRef;
      pendingSeedProjectRef = null;
      if (projects.some((p) => p.ref === seed)) return seed;
    }
    // The live active ref is unusable here: showing the panel deselects the
    // active workspace first, so a query would return null. Use the last
    // workspace the app made active instead (recorded across switches).
    if (lastActiveProjectRef !== null) {
      const project = projects.find((p) => p.ref === lastActiveProjectRef);
      if (project) return project.ref;
    }
    return projects[0]?.ref ?? null;
  }

  /** Open a fresh form session (the always-alive panel surface). */
  async function openSession(): Promise<void> {
    form = initialForm();

    await refreshProjects();
    await refreshAddActions();
    availableAgents = await deps.getAvailableAgents();
    form.agentType = resolveInitialAgentType();
    const seed = computeSeedProject();
    if (seed !== null) {
      form.projectRef = seed;
      form.options = initialOptions(seed);
      form.choicesLoading = true;
    }

    const newHandle = ui.dialog(buildConfig(), { kind: "modeless" });
    handle = newHandle;
    wireSession(newHandle);

    // Fetch the selected backend's launch options for the opening form.
    void loadLaunchOptions();

    // Kick the choices load for the seeded project (re-selects to fetch).
    if (seed !== null) {
      selectProject(seed);
    }
  }

  /** Reset = close + reopen with fresh config (new dialogId remounts the Form). */
  async function resetSession(): Promise<void> {
    if (resetting) return;
    resetting = true;
    try {
      handle?.close();
      handle = null;
      await openSession();
    } finally {
      resetting = false;
    }
  }

  /**
   * What a change to each field does, given the field's new value. Fields that
   * are pushed back keep the config the renderer holds current, so a remounted
   * panel restores what was typed (a changed `initialValue` never re-seeds a
   * live field, so this is harmless to the field being edited).
   */
  const fieldChanges: Readonly<Record<string, (value: string) => void>> = {
    [FIELD_PROJECT]: (raw) => {
      // The dialog hands back a raw string; resolve it against the module's own
      // project list rather than minting a brand from unvalidated UI input.
      const picked = projects.find((p) => p.ref === raw)?.ref;
      if (picked !== undefined && picked !== form.projectRef) selectProject(picked);
    },
    [FIELD_NAME]: (value) => {
      form.name = value;
      form.error = null;
      // Picking a suggestion sets the options it names (git: an existing
      // branch suggests its base), each only when it is one of the choices.
      const suggestion = form.nameSuggestions.find((s) => s.value === value);
      for (const [name, optionValue] of Object.entries(suggestion?.sets ?? {})) {
        if (isChoice(name, optionValue)) form.options[name] = optionValue;
      }
      pushConfig();
    },
    [FIELD_PROMPT]: (value) => {
      form.prompt = value;
      pushConfig();
    },
    [FIELD_AGENT_NAME]: (value) => {
      form.agentName = value;
      pushConfig();
    },
    [FIELD_PERMISSION_MODE]: (value) => {
      form.permissionMode = value;
      pushConfig();
    },
    [FIELD_AGENT]: (value) => {
      if (!isAvailableAgent(value) || value === form.agentType) return;
      form.agentType = value;
      // Fetch the new backend's launch options; loadLaunchOptions clears the
      // stale options and re-renders (which drives whether the permission-mode
      // field appears).
      void loadLaunchOptions();
    },
  };

  function wireSession(sessionHandle: DialogHandle): void {
    sessionHandle.onChange((event) => {
      if (handle !== sessionHandle) return;
      // Any field-change event is user input by definition: the form's own
      // seeding goes through selectProject()/pushConfig(), never through the
      // renderer, so it cannot land here.
      if (!form.dirty) {
        form.dirty = true;
        pushConfig();
      }
      const value = event.data[event.fieldId] ?? "";
      const change = fieldChanges[event.fieldId];
      if (change !== undefined) {
        change(value);
      } else if (optionFields().some(([name]) => name === event.fieldId)) {
        // One of the project type's options.
        form.options[event.fieldId] = value;
        pushConfig();
      }
    });

    sessionHandle.onEvent((event) => {
      if (handle !== sessionHandle) return;
      if (event.actionId === ACTION_CREATE) {
        handleCreate(event.data ?? {});
      } else if (event.actionId === ACTION_RESET) {
        void resetSession();
      } else if (addActions.some((action) => action.id === event.actionId)) {
        handleAddAction(event.actionId);
      }
    });

    sessionHandle.onDismiss(() => {
      if (handle !== sessionHandle) return;
      void resetSession();
    });
  }

  // ---- Actions ----

  function handleCreate(data: Readonly<Record<string, string>>): void {
    // Adopt the snapshot (the debounced name change may not have arrived yet)
    // and re-validate before dispatching.
    form.name = data[FIELD_NAME] ?? form.name;
    for (const [name] of optionFields()) {
      const value = data[name];
      if (value !== undefined) form.options[name] = value;
    }
    const project = selectedProject();
    const workspaceName = resolveName(form.name).trim();

    if (project === undefined || workspaceName === "" || !isFormValid()) {
      pushConfig();
      return;
    }

    // The type's options as its declaration types them; an empty text is "not given".
    const options: Record<string, string | boolean> = {};
    for (const [name, field] of optionFields()) {
      const value = form.options[name] ?? "";
      if (field.kind === "checkbox") options[name] = value === "true";
      else if (value.trim() !== "") options[name] = value.trim();
    }

    const prompt = (data[FIELD_PROMPT] ?? "").trim();
    // Permission mode is absent from the data when the backend doesn't offer it
    // (the field isn't rendered); "" means the default (omit the flag).
    const permissionMode = data[FIELD_PERMISSION_MODE] ?? "";
    const agentName = (data[FIELD_AGENT_NAME] ?? "").trim();
    // The agent dropdown is only rendered when more than one backend is
    // available, so its field is absent from the snapshot on a single-backend
    // install — fall back to the module's own resolved selection rather than
    // treating that as "no backend" (which would drop permissionMode/agentName
    // into the option-less "default" arm).
    const agentSelection = data[FIELD_AGENT] ?? form.agentType ?? "";

    // The form knows the selected backend, so it always emits a typed arm
    // (carrying prompt + options); the resolver only persists it as the
    // workspace's agent when it differs from the global default. Only with no
    // backend at all (no agent installed) do we fall back to the prompt-only
    // "default" arm.
    let agent: AgentSpec | undefined;
    if (isAvailableAgent(agentSelection)) {
      if (agentSelection === "claude") {
        agent = {
          type: "claude",
          ...(prompt !== "" && { prompt }),
          ...(permissionMode !== "" && { permissionMode }),
          ...(agentName !== "" && { agentName }),
        };
      } else {
        agent = {
          type: "opencode",
          ...(prompt !== "" && { prompt }),
          ...(agentName !== "" && { agentName }),
        };
      }
    } else if (prompt !== "") {
      agent = { type: "default", prompt };
    }

    const intent: OpenWorkspaceIntent = {
      type: INTENT_OPEN_WORKSPACE,
      payload: {
        projectRef: project.ref,
        workspaceName,
        options,
        ...(agent !== undefined && { agent }),
        source: "creation",
      },
    };
    logger.debug("Creation form: dispatching workspace:open", {
      project: project.path,
      name: workspaceName,
    });
    // Fire-and-forget: the renderer reacts to workspace:loading (optimistic
    // placeholder + switch) and workspace:create-failed (rollback); the
    // error-notification module surfaces failures.
    void dispatcher.dispatch(intent).catch((error: unknown) => {
      logger.warn("Workspace creation failed", {
        name: workspaceName,
        error: getErrorMessage(error),
      });
    });

    // Fresh form for the next create (the renderer hides the panel by
    // switching to the placeholder workspace).
    void resetSession();
  }

  /**
   * Run a contributed add-project button's flow. While it runs, its button
   * spins and the rest of the row waits; the project it opens becomes the
   * form's selection.
   */
  function handleAddAction(action: string): void {
    if (form.busyAction !== null) return;
    form.busyAction = action;
    form.error = null;
    pushConfig();
    const session = handle;

    const intent: AddProjectIntent = { type: INTENT_ADD_PROJECT, payload: { action } };
    dispatcher.dispatch(intent).then(
      (project) => {
        if (handle !== session) return;
        form.busyAction = null;
        if (project === null) {
          // Canceled, or left to finish in the background.
          pushConfig();
          return;
        }
        pendingSeedProjectRef = null;
        void refreshProjects().then(() => {
          selectProject(project.ref, { refocusName: true });
        });
      },
      (error: unknown) => {
        if (handle !== session) return;
        form.busyAction = null;
        form.error = getErrorMessage(error);
        logger.warn("Failed to add a project from the creation form", {
          action,
          error: form.error,
        });
        pushConfig();
      }
    );
  }

  // ---- Domain event subscriptions ----

  const events = defineEvents({
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        await openSession();
      },
    },
    [EVENT_PROJECT_OPENED]: {
      handler: async (event): Promise<void> => {
        // Startup project restore happens before app:started — no session
        // exists and restored projects are not "freshly opened" seeds.
        if (handle === null) return;
        const { project } = event.payload;
        // Seed the next reset with the freshly opened project; the live form
        // keeps the user's current selection (the project just joins the
        // dropdown list).
        pendingSeedProjectRef = project.ref;
        await refreshProjects();
        pushConfig();
      },
    },
    [EVENT_PROJECT_CLOSED]: {
      handler: async (): Promise<void> => {
        if (handle === null) return;
        await refreshProjects();
        if (form.projectRef !== null && selectedProject() === undefined) {
          // The selected project was closed: fall back to the seed rule.
          const seed = computeSeedProject();
          if (seed !== null) {
            selectProject(seed);
            return;
          }
          form.projectRef = null;
          form.choices = {};
          form.nameSuggestions = [];
          form.choicesLoading = false;
          form.choicesError = null;
          form.options = {};
        }
        pushConfig();
      },
    },
    [EVENT_OPTION_CHOICES_UPDATED]: {
      handler: async (event): Promise<void> => {
        const payload = event.payload;
        if (payload.projectRef !== form.projectRef) return;
        form.choicesLoading = false;
        form.choicesError = null;
        // The fresh answer is authoritative: re-default a selection it no
        // longer contains.
        applyChoices(payload, true);
        pushConfig();
      },
    },
    [EVENT_WORKSPACE_SWITCHED]: {
      handler: async (event): Promise<void> => {
        // The user moved on — a stale "recently opened project" seed should
        // not override the active workspace's project on the next reset.
        pendingSeedProjectRef = null;
        // Remember the active workspace's project for the seed. Only non-null
        // payloads update it: the deselect (null) the renderer fires when
        // showing the panel must not erase the project we want to seed.
        const payload = event.payload;
        if (payload !== null) {
          lastActiveProjectRef = payload.projectRef;
          presetProjectRef = null;
          return;
        }
        // A project card's + asked for this project: it wins over everything.
        if (presetProjectRef !== null) {
          const preset = presetProjectRef;
          presetProjectRef = null;
          if (handle !== null && projects.some((p) => p.ref === preset)) {
            if (preset !== form.projectRef) selectProject(preset);
            return;
          }
        }
        // The panel is being shown. The session outlives switches (so typed
        // input survives), which would leave an untouched form on whatever
        // project it was seeded with — follow the workspace the user came
        // from instead. A touched form keeps everything, project included.
        if (handle === null || form.dirty || resetting || lastActiveProjectRef === null) return;
        const project = projects.find((p) => p.ref === lastActiveProjectRef);
        if (project !== undefined && project.ref !== form.projectRef) {
          selectProject(project.ref);
        }
      },
    },
    [EVENT_WORKSPACE_CREATED]: {
      handler: async (): Promise<void> => {
        if (handle === null) return;
        // Keep duplicate-name validation fresh.
        await refreshProjects();
        pushConfig();
      },
    },
    [EVENT_WORKSPACE_DELETED]: {
      handler: async (): Promise<void> => {
        if (handle === null) return;
        await refreshProjects();
        pushConfig();
      },
    },
  });

  function presetProject(projectRef: ProjectRef, deselecting: boolean): void {
    if (!projects.some((p) => p.ref === projectRef)) return;
    presetProjectRef = deselecting ? projectRef : null;
    if (handle !== null && projectRef !== form.projectRef) selectProject(projectRef);
  }

  return {
    name: "creation",
    events,
    presetProject,
    isEdited: () => form.dirty,
  };
}
