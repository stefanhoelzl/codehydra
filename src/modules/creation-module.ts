/**
 * CreationModule - Backend owner of the "New workspace" creation form.
 *
 * Hosts a declarative Form on the persistent panel surface (the renderer's
 * PanelView). The session is always alive: it opens once on app:started and
 * is reset (close + reopen with fresh config = new dialogId) on every dismiss
 * event. The renderer owns visibility (the new-workspace-view store's isOpen
 * flag) and sends a dismiss both for Escape and when the panel is shown, so a
 * dismiss simply means "give me a fresh form".
 *
 * Responsibilities:
 * - Project row: dropdown of open projects + folder-open (native picker via
 *   the project:open select-folder hook) + git-clone (modal sub-dialog).
 * - Two-phase branch loading per project selection: cached bases display
 *   immediately (project:get-bases with refresh), the loading spinner stays
 *   on until the background refresh confirms via bases:updated.
 * - Per-field validation (name format / duplicates, no base branches) and
 *   Create-button gating, driven by field-change events.
 * - Submit: dispatches workspace:open (source "creation"). The enriched
 *   workspace:loading event drives the renderer's optimistic placeholder;
 *   workspace:create-failed rolls it back. The module just resets the form.
 * - Seeding: the next reset seeds the project from the most recently opened
 *   project (cleared on use and on workspace switch), else the active
 *   workspace's project, else the first open project.
 */

import type { IntentModule, EventDeclarations } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { DialogManager, DialogHandle } from "./dialog-manager";
import type { DialogConfig, DialogSection, DropdownSuggestionGroup } from "../shared/dialog-types";
import type { Logger } from "../boundaries/platform/logging";
import type { AgentInfo, LifecycleAgentType } from "../shared/ipc";
import type { Project, BaseInfo, AgentSpec } from "../shared/api/types";
import { validateWorkspaceName } from "../shared/api/types";
import type { PersistedAccessor } from "../boundaries/platform/store-definition";
import type { ConfigAgentType } from "../boundaries/platform/config";
import type { AppBoundary } from "../boundaries/shell/app";
import { extractGitHubOwnerRepo, buildGitHubNewRepoUrl } from "../shared/github-utils";
import { getErrorMessage } from "../shared/error-utils";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import {
  EVENT_PROJECT_OPENED,
  EVENT_CLONE_PROGRESS,
  INTENT_OPEN_PROJECT,
  type OpenProjectIntent,
  type ProjectOpenedEvent,
  type CloneProgressEvent,
} from "../intents/open-project";
import { EVENT_PROJECT_CLOSED } from "../intents/close-project";
import {
  EVENT_BASES_UPDATED,
  INTENT_GET_PROJECT_BASES,
  type BasesUpdatedEvent,
  type GetProjectBasesIntent,
} from "../intents/get-project-bases";
import { EVENT_WORKSPACE_SWITCHED } from "../intents/switch-workspace";
import {
  INTENT_OPEN_WORKSPACE,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
} from "../intents/open-workspace";
import { EVENT_WORKSPACE_DELETED } from "../intents/delete-workspace";
import { INTENT_LIST_PROJECTS, type ListProjectsIntent } from "../intents/list-projects";
import {
  INTENT_GET_ACTIVE_WORKSPACE,
  type GetActiveWorkspaceIntent,
} from "../intents/get-active-workspace";
import {
  INTENT_GET_LAUNCH_OPTIONS,
  type GetLaunchOptionsIntent,
  type LaunchOptionsResult,
} from "../intents/agent-launch-options";

// =============================================================================
// Dependencies
// =============================================================================

export interface CreationModuleDeps {
  readonly dialogManager: DialogManager;
  readonly dispatcher: Dispatcher;
  readonly appBoundary: Pick<AppBoundary, "openUrl">;
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
const FIELD_BASE = "base";
const FIELD_PROMPT = "prompt";
const FIELD_AGENT = "agent";
const FIELD_AGENT_NAME = "agent-name";
const FIELD_PERMISSION_MODE = "permission-mode";
const ACTION_OPEN_FOLDER = "open-folder";
const ACTION_CLONE = "clone";
const ACTION_CREATE = "create";

const CLONE_FIELD_URL = "url";
const CLONE_ACTION_SUBMIT = "do-clone";
const CLONE_ACTION_CANCEL = "cancel";
const CLONE_ACTION_BACKGROUND = "background";
const CLONE_ACTION_GITHUB_CREATE = "github-create";
const CLONE_ACTION_RETRY = "retry";

// =============================================================================
// Clone URL validation (mirrors the old GitCloneDialog rules)
// =============================================================================

/** Returns an error message for an invalid clone URL, or null when valid/empty. */
export function validateCloneUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Full URL formats (HTTPS, HTTP, SSH, git://, ssh://)
  if (/^https?:\/\/[^\s]+/.test(trimmed)) return null;
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s]+/.test(trimmed)) return null;
  if (/^git:\/\/[^\s]+/.test(trimmed)) return null;
  if (/^ssh:\/\/[^\s]+/.test(trimmed)) return null;
  // Shorthand: org/repo (GitHub shorthand - no dots in first segment)
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) return null;
  // Partial URL: github.com/org/repo (domain without protocol)
  if (/^[a-z0-9.-]+\/[^\s]+$/i.test(trimmed) && trimmed.includes(".")) return null;
  return "Enter a git URL, org/repo, or github.com/org/repo";
}

// =============================================================================
// Module
// =============================================================================

export function createCreationModule(deps: CreationModuleDeps): IntentModule {
  const { dialogManager, dispatcher, logger } = deps;

  // ---- Session state ----

  /** Open projects (id/name/path/workspaces), refreshed via project:list. */
  let projects: readonly Project[] = [];
  /** Agents available at the last session (re)open. */
  let availableAgents: readonly AgentInfo[] = [];
  /** Backend the form currently targets (drives the per-backend fields). */
  let selectedAgentType: LifecycleAgentType | null = null;
  /**
   * Launch options the selected backend reported (via agent:get-launch-options).
   * The form is agent-agnostic: it renders whatever options come back. Re-fetched
   * on every form open / backend switch; the heavy work (e.g. parsing
   * `claude --help`) is cached inside the provider, so re-querying is cheap.
   */
  let launchOptions: LaunchOptionsResult | null = null;
  /** The backend whose launch options are currently being fetched (if any). */
  let loadingLaunchOptionsFor: LifecycleAgentType | null = null;
  let selectedProjectPath: string | null = null;
  let branches: readonly BaseInfo[] = [];
  let branchesLoading = false;
  let branchesError: string | null = null;
  /** Raw name field value (a branch ref after a suggestion pick). */
  let nameValue = "";
  let baseValue = "";
  /** Native folder picker in flight. */
  let pickerBusy = false;
  /** Form-level error (e.g. folder-open failure), shown above the footer. */
  let formError: string | null = null;
  /** Project to seed the next reset with (most recently opened project). */
  let pendingSeedProjectPath: string | null = null;
  /** Guards against overlapping resets (dismiss bursts). */
  let resetting = false;
  /** Invalidates in-flight branch fetches when the selection changes. */
  let selectionEpoch = 0;

  let handle: DialogHandle | null = null;
  let lastConfigJson = "";
  /** Strips the autofocus flag for one config build (focus re-arm nudge). */
  let suppressAutofocus = false;

  // ---- Derived helpers ----

  function selectedProject(): Project | undefined {
    return projects.find((p) => p.path === selectedProjectPath);
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
    return launchOptions?.permissionModes ?? [];
  }

  /** True while the selected backend's launch options are being fetched. */
  function launchOptionsLoading(): boolean {
    return loadingLaunchOptionsFor !== null && loadingLaunchOptionsFor === selectedAgentType;
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
    const backend = selectedAgentType;
    launchOptions = null;
    if (backend === null) {
      pushConfig();
      return;
    }
    loadingLaunchOptionsFor = backend;
    pushConfig();
    try {
      const intent: GetLaunchOptionsIntent = {
        type: INTENT_GET_LAUNCH_OPTIONS,
        payload: { backend },
      };
      const result = await dispatcher.dispatch(intent);
      if (selectedAgentType === backend) launchOptions = result;
    } catch (error) {
      logger.warn("Creation form: launch options fetch failed", {
        error: getErrorMessage(error),
      });
    } finally {
      if (loadingLaunchOptionsFor === backend) loadingLaunchOptionsFor = null;
      pushConfig();
    }
  }

  /**
   * Resolve the raw name field value: a suggestion pick reports the branch
   * ref (unique value) while displaying its derivable name — map it back.
   */
  function resolveName(raw: string): string {
    const branch = branches.find((b) => b.name === raw && b.derives !== undefined);
    return branch?.derives ?? raw;
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
      resolveName(nameValue).trim() !== "" &&
      baseValue !== "" &&
      nameError(nameValue) === null &&
      !pickerBusy
    );
  }

  /** Pick the base to select for a fresh branch list. */
  function pickDefaultBase(
    defaultBaseBranch: string | undefined,
    bases: readonly BaseInfo[]
  ): string {
    if (defaultBaseBranch !== undefined && bases.some((b) => b.name === defaultBaseBranch)) {
      return defaultBaseBranch;
    }
    return bases[0]?.name ?? "";
  }

  // ---- Config building ----

  /** Branch list grouped Local/Remote (label = value = ref name). */
  function baseSuggestions(): DropdownSuggestionGroup[] {
    const local = branches.filter((b) => !b.isRemote);
    const remote = branches.filter((b) => b.isRemote);
    const groups: DropdownSuggestionGroup[] = [];
    if (local.length > 0) {
      groups.push({
        header: "Local Branches",
        items: local.map((b) => ({ value: b.name, label: b.name })),
      });
    }
    if (remote.length > 0) {
      groups.push({
        header: "Remote Branches",
        items: remote.map((b) => ({ value: b.name, label: b.name })),
      });
    }
    return groups;
  }

  /**
   * Name suggestions: derivable branches grouped Local/Remote. The option
   * value is the unique branch ref; the label is the derivable workspace name
   * (what the input displays after a pick).
   */
  function nameSuggestions(): DropdownSuggestionGroup[] {
    const derivable = branches.filter((b) => b.derives !== undefined);
    const local = derivable.filter((b) => !b.isRemote);
    const remote = derivable.filter((b) => b.isRemote);
    const groups: DropdownSuggestionGroup[] = [];
    if (local.length > 0) {
      groups.push({
        header: "Local Branches",
        items: local.map((b) => ({ value: b.name, label: b.derives! })),
      });
    }
    if (remote.length > 0) {
      groups.push({
        header: "Remote Branches",
        items: remote.map((b) => ({ value: b.name, label: b.derives! })),
      });
    }
    return groups;
  }

  function buildConfig(): DialogConfig {
    const hasProject = selectedProject() !== undefined;
    const currentNameError = nameError(nameValue);
    const sections: DialogSection[] = [
      { type: "text", content: "New workspace", style: "heading" },
      {
        type: "group",
        label: "Project",
        items: [
          // Icon buttons lead the row so the tab order matches the visuals:
          // folder -> clone -> project dropdown.
          {
            type: "button" as const,
            id: ACTION_OPEN_FOLDER,
            icon: "folder-opened",
            title: "Open project folder",
            busy: pickerBusy,
            // Without a project the picker buttons are the only way forward.
            ...(!hasProject && { autofocus: true }),
          },
          {
            type: "button" as const,
            id: ACTION_CLONE,
            icon: "source-control",
            title: "Clone from Git",
            disabled: pickerBusy,
          },
          ...(projects.length > 0
            ? [
                {
                  type: "dropdown" as const,
                  id: FIELD_PROJECT,
                  suggestions: [{ items: projects.map((p) => ({ value: p.path, label: p.name })) }],
                  value: selectedProjectPath ?? "",
                  changeEvent: true,
                  disabled: pickerBusy,
                },
              ]
            : [
                {
                  type: "input" as const,
                  id: "project-placeholder",
                  placeholder: "Open folder or clone from Git",
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
        suggestions: nameSuggestions(),
        placeholder: "Enter name or select branch...",
        changeEvent: true,
        disabled: !hasProject || pickerBusy,
        ...(hasProject && !suppressAutofocus && { autofocus: true }),
        ...(currentNameError !== null && { error: currentNameError }),
      },
      {
        type: "dropdown",
        id: FIELD_BASE,
        label: "Base Branch",
        suggestions: baseSuggestions(),
        value: baseValue,
        placeholder: "Select branch...",
        changeEvent: true,
        loading: branchesLoading,
        disabled: !hasProject || pickerBusy,
        ...(branchesError !== null && { error: branchesError }),
      },
      {
        type: "input",
        id: FIELD_PROMPT,
        label: "Prompt",
        multiline: true,
        rows: 3,
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
        value: selectedAgentType ?? "",
        changeEvent: true,
      });
    }

    // Named agent/persona — free text for any backend (maps to the backend's
    // named-agent option). Empty reports "" and omits the flag.
    sections.push({
      type: "input",
      id: FIELD_AGENT_NAME,
      label: "Agent name",
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
        loading: launchOptionsLoading(),
      });
    }

    if (formError !== null) {
      sections.push({ type: "text", content: formError, icon: "error" });
    }

    sections.push({
      type: "group",
      align: "right",
      items: [
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

  /** Push the current config, skipping the update when nothing changed. */
  function pushConfig(): void {
    if (!handle) return;
    const config = buildConfig();
    const json = JSON.stringify(config);
    if (json === lastConfigJson) return;
    lastConfigJson = json;
    handle.update(config);
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

  /**
   * Select a project: clear branch data, push the loading state, then fetch
   * the cached bases (refresh kicks the background git fetch whose result
   * arrives via bases:updated and turns the spinner off).
   *
   * refocusName re-arms the renderer's autofocus-move detection (a push
   * without the flag, then the regular config) so the name field gets focused
   * even when it already carried the flag — used by the folder-open and
   * git-clone flows.
   */
  function selectProject(projectPath: string, options?: { refocusName?: boolean }): void {
    selectedProjectPath = projectPath;
    branches = [];
    branchesLoading = true;
    branchesError = null;
    baseValue = "";
    formError = null;
    const epoch = ++selectionEpoch;
    if (options?.refocusName) {
      suppressAutofocus = true;
      pushConfig();
      suppressAutofocus = false;
    }
    pushConfig();

    const intent: GetProjectBasesIntent = {
      type: INTENT_GET_PROJECT_BASES,
      payload: { projectPath, refresh: true },
    };
    dispatcher.dispatch(intent).then(
      (result) => {
        if (epoch !== selectionEpoch) return;
        branches = result.bases;
        baseValue = pickDefaultBase(result.defaultBaseBranch, result.bases);
        // Loading stays on until bases:updated confirms the fresh list.
        pushConfig();
      },
      (error: unknown) => {
        if (epoch !== selectionEpoch) return;
        branchesError = getErrorMessage(error);
        branchesLoading = false;
        pushConfig();
      }
    );
  }

  // ---- Session lifecycle ----

  /** Seed rule: pending opened project > active workspace's project > first. */
  async function computeSeedProject(): Promise<string | null> {
    if (pendingSeedProjectPath !== null) {
      const seed = pendingSeedProjectPath;
      pendingSeedProjectPath = null;
      if (projects.some((p) => p.path === seed)) return seed;
    }
    try {
      const intent: GetActiveWorkspaceIntent = {
        type: INTENT_GET_ACTIVE_WORKSPACE,
        payload: {},
      };
      const ref = await dispatcher.dispatch(intent);
      if (ref) {
        const project = projects.find((p) => p.id === ref.projectId);
        if (project) return project.path;
      }
    } catch (error) {
      logger.debug("Creation form: active workspace lookup failed", {
        error: getErrorMessage(error),
      });
    }
    return projects[0]?.path ?? null;
  }

  /** Open a fresh form session (the always-alive panel surface). */
  async function openSession(): Promise<void> {
    selectedProjectPath = null;
    branches = [];
    branchesLoading = false;
    branchesError = null;
    nameValue = "";
    baseValue = "";
    pickerBusy = false;
    formError = null;
    launchOptions = null;
    loadingLaunchOptionsFor = null;

    await refreshProjects();
    availableAgents = await deps.getAvailableAgents();
    selectedAgentType = resolveInitialAgentType();
    const seed = await computeSeedProject();
    if (seed !== null) {
      selectedProjectPath = seed;
      branchesLoading = true;
    }

    const config = buildConfig();
    lastConfigJson = JSON.stringify(config);
    const newHandle = dialogManager.open(config, { surface: "panel" });
    handle = newHandle;
    wireSession(newHandle);

    // Fetch the selected backend's launch options for the opening form.
    void loadLaunchOptions();

    // Kick the branch load for the seeded project (re-selects to fetch).
    if (seed !== null) {
      selectProject(seed);
    }
  }

  /** Reset = close + reopen with fresh config (new dialogId remounts the Form). */
  async function resetSession(): Promise<void> {
    if (resetting) return;
    resetting = true;
    try {
      closeCloneDialog();
      handle?.close();
      handle = null;
      await openSession();
    } finally {
      resetting = false;
    }
  }

  function wireSession(sessionHandle: DialogHandle): void {
    sessionHandle.onChange((event) => {
      if (handle !== sessionHandle) return;
      const data = event.data;
      if (event.fieldId === FIELD_PROJECT) {
        const path = data[FIELD_PROJECT] ?? "";
        if (path !== "" && path !== selectedProjectPath) {
          selectProject(path);
        }
      } else if (event.fieldId === FIELD_NAME) {
        nameValue = data[FIELD_NAME] ?? "";
        formError = null;
        // Picking an existing branch suggests its base.
        const branch = branches.find((b) => b.name === nameValue && b.derives !== undefined);
        if (branch?.base !== undefined && branches.some((b) => b.name === branch.base)) {
          baseValue = branch.base;
        }
        pushConfig();
      } else if (event.fieldId === FIELD_BASE) {
        baseValue = data[FIELD_BASE] ?? "";
        pushConfig();
      } else if (event.fieldId === FIELD_AGENT) {
        const next = data[FIELD_AGENT] ?? "";
        if (isAvailableAgent(next) && next !== selectedAgentType) {
          selectedAgentType = next;
          // Fetch the new backend's launch options; loadLaunchOptions clears the
          // stale options and re-renders (which drives whether the
          // permission-mode field appears).
          void loadLaunchOptions();
        }
      }
    });

    sessionHandle.onEvent((event) => {
      if (handle !== sessionHandle) return;
      if (event.actionId === ACTION_CREATE) {
        handleCreate(event.data ?? {});
      } else if (event.actionId === ACTION_OPEN_FOLDER) {
        handleOpenFolder();
      } else if (event.actionId === ACTION_CLONE) {
        openCloneDialog();
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
    nameValue = data[FIELD_NAME] ?? nameValue;
    baseValue = data[FIELD_BASE] ?? baseValue;
    const project = selectedProject();
    const workspaceName = resolveName(nameValue).trim();
    const base = baseValue;

    if (
      project === undefined ||
      workspaceName === "" ||
      base === "" ||
      nameError(nameValue) !== null
    ) {
      pushConfig();
      return;
    }

    const prompt = (data[FIELD_PROMPT] ?? "").trim();
    // Permission mode is absent from the data when the backend doesn't offer it
    // (the field isn't rendered); "" means the default (omit the flag).
    const permissionMode = data[FIELD_PERMISSION_MODE] ?? "";
    const agentName = (data[FIELD_AGENT_NAME] ?? "").trim();
    const agentSelection = data[FIELD_AGENT] ?? "";

    // The form knows the selected backend, so it always emits a typed arm
    // (carrying prompt + options); the resolver only persists it as the
    // workspace's agent when it differs from the global default. With no
    // backend selected, fall back to the prompt-only "default" arm.
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
        projectPath: project.path,
        workspaceName,
        base,
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

  function handleOpenFolder(): void {
    if (pickerBusy) return;
    pickerBusy = true;
    formError = null;
    pushConfig();

    const intent: OpenProjectIntent = { type: INTENT_OPEN_PROJECT, payload: {} };
    dispatcher.dispatch(intent).then(
      (project) => {
        pickerBusy = false;
        if (project === null) {
          // User canceled the native picker.
          pushConfig();
          return;
        }
        pendingSeedProjectPath = null;
        void refreshProjects().then(() => {
          selectProject(project.path, { refocusName: true });
        });
      },
      (error: unknown) => {
        pickerBusy = false;
        formError = getErrorMessage(error);
        logger.warn("Failed to open project from creation form", { error: formError });
        pushConfig();
      }
    );
  }

  // ---- Clone sub-dialog ----

  interface CloneViewState {
    url: string;
    /** The URL this dialog submitted (null = not cloning). */
    cloneUrl: string | null;
    error: string | null;
    /** Latest clone progress (from clone:progress events) while cloning. */
    progress: { stage: string; progress: number } | null;
  }

  interface CloneDialogState extends CloneViewState {
    readonly handle: DialogHandle;
  }

  let cloneDialog: CloneDialogState | null = null;

  function buildCloneConfig(state: CloneViewState): DialogConfig {
    const cloning = state.cloneUrl !== null;
    const validationError = validateCloneUrl(state.url);
    const gitHubInfo = state.error !== null ? extractGitHubOwnerRepo(state.url.trim()) : null;

    const sections: DialogSection[] = [
      { type: "text", content: "Clone from Git Repository", style: "heading" },
      {
        type: "input",
        id: CLONE_FIELD_URL,
        label: "Repository URL",
        placeholder: "org/repo or https://github.com/org/repo.git",
        // Immediate so the Clone button's enabled state can't lag behind the
        // typed URL when the user hits Enter right after typing.
        changeEvent: { debounceMs: 0 },
        disabled: cloning,
        autofocus: true,
        ...(validationError !== null && { error: validationError }),
      },
    ];

    if (cloning) {
      sections.push({
        type: "progress",
        items: [
          {
            id: "clone",
            label: "Cloning repository",
            status: "running",
            ...(state.progress !== null && {
              progress: state.progress.progress,
              message: state.progress.stage,
            }),
          },
        ],
      });
    }

    if (state.error !== null && gitHubInfo !== null) {
      sections.push(
        { type: "text", content: `${gitHubInfo.owner}/${gitHubInfo.repo} not found on GitHub.` },
        {
          type: "group",
          align: "left",
          items: [
            {
              type: "button",
              id: CLONE_ACTION_GITHUB_CREATE,
              label: "Create on GitHub",
              icon: "github",
            },
          ],
        },
        {
          type: "text",
          content: "Initialize with a README to enable cloning.",
          icon: "warning",
          style: "subtitle",
        }
      );
    } else if (state.error !== null) {
      sections.push({ type: "text", content: state.error, icon: "error" });
    }

    const footer: DialogSection = cloning
      ? {
          type: "group",
          align: "right",
          // role "cancel": mid-clone, Escape detaches like this button.
          items: [
            {
              type: "button",
              id: CLONE_ACTION_BACKGROUND,
              label: "Continue in background",
              role: "cancel",
            },
          ],
        }
      : {
          // Tab order: input -> Clone -> Cancel; visually Cancel sits left of
          // the primary (reverse rendering).
          type: "group",
          align: "right",
          reverse: true,
          items: [
            gitHubInfo !== null
              ? { type: "button" as const, id: CLONE_ACTION_RETRY, label: "Retry Clone" }
              : {
                  type: "button" as const,
                  id: CLONE_ACTION_SUBMIT,
                  label: "Clone",
                  variant: "primary" as const,
                  disabled: state.url.trim() === "" || validationError !== null,
                },
            {
              type: "button" as const,
              id: CLONE_ACTION_CANCEL,
              label: "Cancel",
              variant: "secondary" as const,
              role: "cancel" as const,
            },
          ],
        };
    sections.push(footer);

    return { sections, layout: "form", modal: true };
  }

  function updateCloneDialog(): void {
    if (cloneDialog === null) return;
    cloneDialog.handle.update(buildCloneConfig(cloneDialog));
  }

  function closeCloneDialog(): void {
    if (cloneDialog === null) return;
    cloneDialog.handle.close();
    cloneDialog = null;
  }

  function startClone(state: CloneDialogState): void {
    const url = state.url.trim();
    if (url === "" || validateCloneUrl(url) !== null || state.cloneUrl !== null) return;
    state.error = null;
    state.cloneUrl = url;
    state.progress = null;
    updateCloneDialog();
    logger.debug("Cloning repository", { url });

    const intent: OpenProjectIntent = { type: INTENT_OPEN_PROJECT, payload: { git: url } };
    dispatcher.dispatch(intent).then(
      (project) => {
        // Only react if this dialog instance still owns the clone.
        if (cloneDialog !== state || state.cloneUrl !== url) return;
        closeCloneDialog();
        if (project !== null) {
          pendingSeedProjectPath = null;
          void refreshProjects().then(() => {
            selectProject(project.path, { refocusName: true });
          });
        }
      },
      (error: unknown) => {
        if (cloneDialog !== state || state.cloneUrl !== url) return;
        state.error = getErrorMessage(error);
        state.cloneUrl = null;
        state.progress = null;
        logger.warn("Clone failed", { url, error: state.error });
        updateCloneDialog();
      }
    );
  }

  function openCloneDialog(): void {
    if (cloneDialog !== null) return;
    const initial: CloneViewState = { url: "", cloneUrl: null, error: null, progress: null };
    const cloneHandle = dialogManager.open(buildCloneConfig(initial));
    const state: CloneDialogState = { ...initial, handle: cloneHandle };
    cloneDialog = state;

    cloneHandle.onChange((event) => {
      if (cloneDialog !== state) return;
      if (event.fieldId === CLONE_FIELD_URL) {
        state.url = event.data[CLONE_FIELD_URL] ?? "";
        // Clear the submit error when the user types (mirrors the old dialog).
        if (state.error !== null) state.error = null;
        updateCloneDialog();
      }
    });

    // Escape is declarative: the footer's cancel-role button (Cancel when
    // idle/error, "Continue in background" mid-clone) is clicked through the
    // action path below.
    cloneHandle.onEvent((event) => {
      if (cloneDialog !== state) return;
      state.url = event.data?.[CLONE_FIELD_URL] ?? state.url;
      switch (event.actionId) {
        case CLONE_ACTION_SUBMIT:
          startClone(state);
          break;
        case CLONE_ACTION_RETRY:
          state.error = null;
          startClone(state);
          break;
        case CLONE_ACTION_BACKGROUND:
          // Detach: the clone keeps running; project:opened lands silently.
          logger.debug("Clone continuing in background", { url: state.cloneUrl });
          closeCloneDialog();
          break;
        case CLONE_ACTION_CANCEL:
          if (state.cloneUrl === null) closeCloneDialog();
          break;
        case CLONE_ACTION_GITHUB_CREATE: {
          const gitHubInfo = extractGitHubOwnerRepo(state.url.trim());
          if (gitHubInfo !== null) {
            const createUrl = buildGitHubNewRepoUrl(gitHubInfo.owner, gitHubInfo.repo);
            logger.info("Opening GitHub repo creation", { url: createUrl });
            void deps.appBoundary.openUrl(createUrl);
          }
          break;
        }
      }
    });
  }

  // ---- Domain event subscriptions ----

  const events: EventDeclarations = {
    [EVENT_APP_STARTED]: {
      handler: async (): Promise<void> => {
        await openSession();
      },
    },
    [EVENT_PROJECT_OPENED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        // Startup project restore happens before app:started — no session
        // exists and restored projects are not "freshly opened" seeds.
        if (handle === null) return;
        const { project } = (event as ProjectOpenedEvent).payload;
        // Seed the next reset with the freshly opened project; the live form
        // keeps the user's current selection (the project just joins the
        // dropdown list).
        pendingSeedProjectPath = project.path;
        await refreshProjects();
        pushConfig();
      },
    },
    [EVENT_PROJECT_CLOSED]: {
      handler: async (): Promise<void> => {
        if (handle === null) return;
        await refreshProjects();
        if (selectedProjectPath !== null && selectedProject() === undefined) {
          // The selected project was closed: fall back to the seed rule.
          const seed = await computeSeedProject();
          if (seed !== null) {
            selectProject(seed);
            return;
          }
          selectedProjectPath = null;
          branches = [];
          branchesLoading = false;
          branchesError = null;
          baseValue = "";
        }
        pushConfig();
      },
    },
    [EVENT_BASES_UPDATED]: {
      handler: async (event: DomainEvent): Promise<void> => {
        const payload = (event as BasesUpdatedEvent).payload;
        if (payload.projectPath !== selectedProjectPath) return;
        branches = payload.bases;
        branchesLoading = false;
        branchesError = payload.bases.length === 0 ? "No base branches available" : null;
        // The fresh list is authoritative: re-default a selection it no
        // longer contains.
        if (!payload.bases.some((b) => b.name === baseValue)) {
          baseValue = pickDefaultBase(payload.defaultBaseBranch, payload.bases);
        }
        pushConfig();
      },
    },
    [EVENT_CLONE_PROGRESS]: {
      handler: async (event: DomainEvent): Promise<void> => {
        // Inline progress in the clone sub-dialog (the clone-notification
        // module independently shows the sidebar notification). The event
        // carries progress 0-1; ProgressItem expects 0-100.
        const payload = (event as CloneProgressEvent).payload;
        if (cloneDialog === null || cloneDialog.cloneUrl !== payload.url) return;
        cloneDialog.progress = {
          stage: payload.stage,
          progress: Math.round(payload.progress * 100),
        };
        updateCloneDialog();
      },
    },
    [EVENT_WORKSPACE_SWITCHED]: {
      handler: async (): Promise<void> => {
        // The user moved on — a stale "recently opened project" seed should
        // not override the active workspace's project on the next reset.
        pendingSeedProjectPath = null;
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
  };

  return {
    name: "creation",
    events,
  };
}
