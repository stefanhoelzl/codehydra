/**
 * AutoWorkspaceModule — polls user-defined command sources and creates
 * workspaces to match.
 *
 * Sources are data, not code: the `auto-workspace.sources` config value is a
 * multi-document YAML stream (one document per source; see source-config.ts).
 * Each source's `cmd` emits a JSON array of domain objects; the source's
 * `template` renders one workspace definition per object (see template-render.ts).
 *
 * A single chained timer drives everything: each cycle re-reads the config
 * (picking up edits without a restart), then polls every source. Per source:
 *   - a key already tracked in state is skipped
 *   - a new key creates a workspace (state entry written only on success)
 *   - a tracked key absent from this cycle is forgotten (so a re-appearing item
 *     is recreated)
 * There is no auto-deletion; a manually deleted workspace's entry simply
 * persists (so it is not recreated while its item is still active) and is
 * forgotten once the item disappears. Name collision on create is the
 * idempotency backstop.
 *
 * `auto-workspace.poll-interval` (seconds, default 60) is the *gap between
 * runs*: the next wait is armed only once a cycle has settled, so a slow poll
 * never stacks. The value is re-read when each wait is armed, so a change made
 * in the settings dialog applies once the current wait elapses.
 *
 * Hooks:
 * - app:start -> "start": import the pre-state.json auto-workspaces.json, once
 * - app:shutdown -> "stop": stop polling
 *
 * Events:
 * - app:started: load state, run the first cycle, start polling
 */

import type { IntentModule } from "../../intents/lib/module";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import { APP_START_OPERATION_ID } from "../../intents/app-start";
import { EVENT_APP_STARTED } from "../../intents/app-ready";
import { APP_SHUTDOWN_OPERATION_ID } from "../../intents/app-shutdown";
import { INTENT_OPEN_WORKSPACE, type OpenWorkspaceIntent } from "../../intents/open-workspace";
import {
  INTENT_GET_PROJECT_BASES,
  type GetProjectBasesIntent,
} from "../../intents/get-project-bases";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "../../intents/open-project";
import { INTENT_SET_METADATA, type SetMetadataIntent } from "../../intents/set-metadata";
import type { Config } from "../../boundaries/platform/config";
import {
  storeString,
  storeText,
  storeCustom,
  storeNumber,
  type PersistedAccessor,
} from "../../boundaries/platform/store-definition";
import { SOURCES_HELP } from "./template-defaults";
import type { StateService } from "../../boundaries/platform/state-service";
import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { AgentSpec } from "../../shared/api/types";
import { getErrorMessage } from "../../shared/error-utils";
import { Path } from "../../utils/path/path";
import { parseSources, validateSourcesConfig, type ParsedSource } from "./source-config";
import { renderDefinition } from "./template-render";
import { runCmd } from "./cmd-runner";
import { projectPathSchema } from "../../intents/contract";

// =============================================================================
// State
// =============================================================================

interface StateEntry {
  readonly workspaceName: string;
  readonly createdAt: string;
}

/** Tracking map `${source}/${itemKey}` -> entry, stored under `auto-workspaces`. */
type AutoWorkspaceEntries = Record<string, StateEntry>;

function isStateEntry(value: unknown): value is StateEntry {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.workspaceName === "string" && typeof o.createdAt === "string";
}

function validateEntries(value: unknown): AutoWorkspaceEntries | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: AutoWorkspaceEntries = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isStateEntry(entry)) {
      out[key] = { workspaceName: entry.workspaceName, createdAt: entry.createdAt };
    }
  }
  return out;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// =============================================================================
// Constants
// =============================================================================

/** Default gap between the end of one reconcile-and-poll cycle and the next. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const METADATA_SOURCE_KEY = "source";

// =============================================================================
// Dependencies
// =============================================================================

export interface AutoWorkspaceModuleDeps {
  readonly fs: Pick<FileSystemBoundary, "readFile" | "rm">;
  readonly logger: Logger;
  /** Path of the pre-state.json `auto-workspaces.json`, imported once then deleted. */
  readonly legacyStateFilePath: string;
  readonly dispatcher: Dispatcher;
  readonly processRunner: ProcessRunner;
  readonly configService: Config;
  readonly stateService: StateService;
}

// =============================================================================
// Helpers
// =============================================================================

function stateKey(sourceName: string, itemKey: string): string {
  return `${sourceName}/${itemKey}`;
}

function sourceOfKey(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(0, slash);
}

// =============================================================================
// Factory
// =============================================================================

export function createAutoWorkspaceModule(deps: AutoWorkspaceModuleDeps): IntentModule {
  const sourcesBase = storeText({
    nullable: true,
    rows: 20,
    helpLabel: "Source format reference",
    helpPanel: SOURCES_HELP,
  });
  const sourcesAccessor: PersistedAccessor<string | null> = deps.configService.register(
    "auto-workspace.sources",
    {
      default: null,
      description: "Auto-workspace sources (multi-document YAML; one document per source)",
      applies: "live",
      // May embed secrets (e.g. an inlined API token in a cmd): kept out of bug
      // reports, but shown in the clear in the settings editor — hence omit.
      omit: true,
      ...sourcesBase,
      validate: (v: unknown): string | null | undefined => {
        const parsed = sourcesBase.validate(v);
        if (parsed === undefined) return undefined;
        return validateSourcesConfig(parsed);
      },
    }
  );

  const intervalAccessor: PersistedAccessor<number> = deps.configService.register(
    "auto-workspace.poll-interval",
    {
      default: DEFAULT_POLL_INTERVAL_SECONDS,
      description:
        "Seconds to wait between the end of one auto-workspace poll and the start of the next " +
        "(a change applies after the current wait elapses)",
      applies: "live",
      ...storeNumber({ min: 1 }),
    }
  );

  // The retired experimental.* keys of the hardcoded GitHub/YouTrack sources.
  // Nothing reads them — they stay registered only so that an upgrade does not
  // silently delete them: an unregistered key is "unknown", which Config warns
  // about and strips from config.json. Keeping them deprecated preserves the old
  // templates and credentials on disk (read-only, hidden from help) so they can
  // be ported into `auto-workspace.sources` by hand.
  for (const key of [
    "experimental.github.template",
    "experimental.github.template-path",
    "experimental.github.query",
    "experimental.youtrack.template",
    "experimental.youtrack.template-path",
    "experimental.youtrack.base-url",
    "experimental.youtrack.token",
    "experimental.youtrack.query",
  ]) {
    deps.configService.register(key, {
      default: null,
      deprecated: true,
      description: "(deprecated) retired; port into auto-workspace.sources by hand",
      ...storeString({ nullable: true }),
    });
  }

  const stateAccessor = deps.stateService.register("auto-workspaces", {
    default: {} as AutoWorkspaceEntries,
    description: "Auto-workspace tracking entries (app-managed)",
    ...storeCustom<AutoWorkspaceEntries>({
      parse: (raw) => validateEntries(safeJsonParse(raw)),
      validate: validateEntries,
    }),
  });

  let entries: AutoWorkspaceEntries = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Interval the last wait was armed with, so a live change can be logged once. */
  let armedIntervalSeconds: number | null = null;

  // ------ State persistence ------

  async function persist(): Promise<void> {
    try {
      await stateAccessor.set(entries);
    } catch (error) {
      deps.logger.warn("Failed to save auto-workspace state", { error: getErrorMessage(error) });
    }
  }

  // ------ Migrations (one-shot, on first launch after upgrade) ------

  async function migrateLegacyStateFile(): Promise<void> {
    if (!stateAccessor.isDefault()) return;
    let raw: string;
    try {
      raw = await deps.fs.readFile(deps.legacyStateFilePath);
    } catch {
      return;
    }
    const parsed = safeJsonParse(raw);
    const entriesValue =
      typeof parsed === "object" && parsed !== null && "entries" in parsed
        ? (parsed as { entries: unknown }).entries
        : parsed;
    const migrated = validateEntries(entriesValue);
    if (migrated && Object.keys(migrated).length > 0) {
      try {
        await stateAccessor.set(migrated);
        deps.logger.info("Migrated auto-workspaces.json into state.json", {
          count: Object.keys(migrated).length,
        });
      } catch (error) {
        deps.logger.warn("Failed to migrate auto-workspaces.json into state.json", {
          error: getErrorMessage(error),
        });
        return;
      }
    }
    await deps.fs.rm(deps.legacyStateFilePath, { force: true }).catch(() => {});
  }

  // ------ Workspace lifecycle ------

  /**
   * Create a workspace for a new item. Returns the state entry on success, or
   * null on any failure — the caller then does NOT record the item, so it is
   * retried next tick.
   */
  async function createWorkspace(
    source: ParsedSource,
    key: string,
    data: unknown
  ): Promise<StateEntry | null> {
    try {
      const { definition, warnings } = renderDefinition(source.template, data);
      for (const warning of warnings) {
        deps.logger.warn("Template warning", { source: source.name, key, warning });
      }

      let projectPayload: OpenProjectIntent["payload"] | null = null;
      if (definition.project)
        // A user-authored template value: normalize, then mint the brand by parsing.
        projectPayload = { path: projectPathSchema.parse(new Path(definition.project).toString()) };
      else if (definition.git) projectPayload = { git: definition.git };
      if (!projectPayload) {
        deps.logger.warn("Skipping auto-workspace (no project/git in template)", { key });
        return null;
      }

      const project = await deps.dispatcher.dispatch<OpenProjectIntent>({
        type: INTENT_OPEN_PROJECT,
        payload: projectPayload,
      });
      if (!project) {
        deps.logger.warn("project:open returned null for auto-workspace", { key });
        return null;
      }

      await deps.dispatcher.dispatch<GetProjectBasesIntent>({
        type: INTENT_GET_PROJECT_BASES,
        payload: { projectPath: project.path, refresh: true, wait: true },
      });

      const agent: AgentSpec = definition.agent ?? {
        type: "default",
        ...(definition.prompt !== "" && { prompt: definition.prompt }),
      };

      const wsResult = await deps.dispatcher.dispatch<OpenWorkspaceIntent>({
        type: INTENT_OPEN_WORKSPACE,
        payload: {
          workspaceName: definition.name,
          ...(definition.base !== undefined && { base: definition.base }),
          ...(definition.tracking !== undefined && { tracking: definition.tracking }),
          stealFocus: definition.focus ?? false,
          projectPath: project.path,
          agent,
          source: "auto-workspace",
        },
      });

      const allMetadata: Record<string, string> = {
        [METADATA_SOURCE_KEY]: source.name,
        ...(definition.metadata ?? {}),
      };
      for (const [metaKey, value] of Object.entries(allMetadata)) {
        try {
          await deps.dispatcher.dispatch<SetMetadataIntent>({
            type: INTENT_SET_METADATA,
            payload: { workspacePath: wsResult.path, key: metaKey, value },
          });
        } catch (error) {
          deps.logger.warn("Failed to set workspace metadata", {
            key: metaKey,
            stateKey: key,
            error: getErrorMessage(error),
          });
        }
      }

      deps.logger.info("Auto-workspace created", {
        source: source.name,
        key,
        workspaceName: definition.name,
      });
      return { workspaceName: definition.name, createdAt: new Date().toISOString() };
    } catch (error) {
      // No entry written → retried next tick (name collision, invalid name, or a
      // transient failure all land here; the intent's source:"auto-workspace"
      // suppresses a user-facing error notification).
      deps.logger.warn("Failed to create auto-workspace (will retry)", {
        source: source.name,
        key,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  // ------ Poll cycle ------

  async function pollSource(source: ParsedSource): Promise<boolean> {
    let items: unknown[];
    try {
      items = await runCmd({ processRunner: deps.processRunner }, source.cmd);
    } catch (error) {
      deps.logger.warn("Source cmd failed, skipping tick", {
        source: source.name,
        error: getErrorMessage(error),
      });
      return false;
    }

    const prefix = `${source.name}/`;
    const activeStateKeys = new Set<string>();
    const newItems: { key: string; data: unknown }[] = [];

    for (const data of items) {
      let key: string;
      try {
        key = renderDefinition(source.template, data).definition.key;
      } catch (error) {
        deps.logger.warn("Failed to render item key, skipping item", {
          source: source.name,
          error: getErrorMessage(error),
        });
        continue;
      }
      const fullKey = stateKey(source.name, key);
      activeStateKeys.add(fullKey);
      if (!(fullKey in entries)) newItems.push({ key: fullKey, data });
    }

    let changed = false;

    // Forget entries for this source whose item is no longer active.
    for (const key of Object.keys(entries)) {
      if (key.startsWith(prefix) && !activeStateKeys.has(key)) {
        delete entries[key];
        changed = true;
        deps.logger.info("Forgot auto-workspace entry (item disappeared)", {
          source: source.name,
          key,
        });
      }
    }

    // Create workspaces for new items.
    for (const { key, data } of newItems) {
      const entry = await createWorkspace(source, key, data);
      if (entry) {
        entries[key] = entry;
        changed = true;
      }
    }

    return changed;
  }

  async function reconcile(): Promise<void> {
    const { sources, errors } = parseSources(sourcesAccessor.get());
    for (const err of errors) {
      deps.logger.warn("Invalid auto-workspace source, ignoring", {
        source: err.name ?? `#${err.index}`,
        message: err.message,
      });
    }

    let changed = false;

    // Orphan cleanup: drop entries whose source no longer exists in config.
    const validNames = new Set(sources.map((s) => s.name));
    for (const key of Object.keys(entries)) {
      if (!validNames.has(sourceOfKey(key))) {
        delete entries[key];
        changed = true;
        deps.logger.info("Forgot auto-workspace entry (source removed)", { key });
      }
    }

    for (const source of sources) {
      if (await pollSource(source)) changed = true;
    }

    if (changed) await persist();
  }

  /**
   * Arm the next wait. Chained rather than periodic: the wait is the gap between
   * the end of one cycle and the start of the next, so a slow poll never stacks.
   * The interval is re-read here, so a live change applies from the next wait on.
   */
  function scheduleNext(): void {
    if (stopped || timer) return;
    const intervalSeconds = intervalAccessor.get();
    if (armedIntervalSeconds !== null && armedIntervalSeconds !== intervalSeconds) {
      deps.logger.info("Auto-workspace poll interval changed", {
        from: armedIntervalSeconds,
        to: intervalSeconds,
      });
    }
    armedIntervalSeconds = intervalSeconds;
    timer = setTimeout(() => {
      timer = null;
      void reconcile()
        .catch((error: unknown) => {
          deps.logger.warn("Auto-workspace poll failed", { error: getErrorMessage(error) });
        })
        .finally(scheduleNext);
    }, intervalSeconds * 1000);
  }

  function startPolling(): void {
    if (stopped || timer) return;
    deps.logger.info("Auto-workspace polling started", {
      intervalSeconds: intervalAccessor.get(),
    });
    scheduleNext();
  }

  function stopPolling(): void {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      deps.logger.info("Auto-workspace polling stopped");
    }
  }

  // ------ Module definition ------

  return {
    name: "auto-workspace",
    hooks: {
      [APP_START_OPERATION_ID]: {
        start: {
          handler: async (): Promise<void> => {
            await migrateLegacyStateFile();
          },
        },
      },
      [APP_SHUTDOWN_OPERATION_ID]: {
        stop: {
          handler: async () => {
            stopPolling();
          },
        },
      },
    },
    events: {
      [EVENT_APP_STARTED]: {
        handler: async (): Promise<void> => {
          entries = stateAccessor.get();
          await reconcile();
          startPolling();
        },
      },
    },
  };
}
