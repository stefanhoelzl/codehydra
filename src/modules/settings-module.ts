/**
 * SettingsModule - the auto-populated settings dialog.
 *
 * Enumerates the Config registry and builds a declarative settings dialog from
 * each key's `settingsControl` + `applies` metadata — no hand-maintained list.
 * Opened two ways, both landing on openSettings():
 *   - Alt+X then S: the shortcut-key domain event (key "s").
 *   - the sidebar gear: the renderer's `open-settings` ui event, forwarded by
 *     the presenter through the injected onOpenSettings callback (main.ts wires
 *     it to this module's openSettings).
 *
 * Grouping is derived verbatim from the dot-separated key (segment 1 = group,
 * segment 2 = sub-heading, remainder = label; a dotless key falls under
 * "General"). Controls are inferred from each key's settingsControl. Sensitive
 * (redact) keys render masked. Editing is buffered: Save / Save & Restart
 * persist the buffer (Save & Restart then relaunches), Cancel discards. Live
 * validation disables Save while any field is invalid; per-row reset and "Reset
 * all to defaults" revert to defaults immediately.
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { DialogHandle } from "./presentation/sessions";
import type { UiPresenter } from "./presentation/presentation-module";
import type { Logger } from "../boundaries/platform/logging";
import type { Config, ConfigSource } from "../boundaries/platform/config";
import type {
  PersistedKeyDefinition,
  SettingsControl,
} from "../boundaries/platform/store-definition";
import type { AppBoundary } from "../boundaries/shell/app";
import type { DialogBoundary } from "../boundaries/shell/dialog";
import type { FileSystemBoundary } from "../boundaries/platform/filesystem";
import type { DialogConfig, DialogSection, SettingRowField } from "../shared/dialog-types";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";
import { FileSystemError } from "../shared/errors/service-errors";

// =============================================================================
// Constants
// =============================================================================

/** Keys that are registered config but not user settings (excluded from the UI). */
const EXCLUDED_KEYS = new Set(["help"]);

/** Group heading for dotless (top-level) keys. */
const GENERAL_GROUP = "General";

const ACTION_SAVE = "save";
const ACTION_SAVE_RESTART = "save-restart";
const ACTION_CANCEL = "cancel";
const ACTION_RESET_ALL = "reset-all";
/** Per-row reset action ids are `${RESET_PREFIX}${key}`. */
const RESET_PREFIX = "reset:";
/** Per-row path-picker action ids are `${PICK_PREFIX}${key}`. */
const PICK_PREFIX = "pick:";
/** Sub-field id suffix for a guarded-text control's on/off checkbox. */
const GUARD_ON_SUFFIX = "::on";

// =============================================================================
// Dependencies
// =============================================================================

export interface SettingsModuleDeps {
  readonly ui: UiPresenter;
  readonly config: Config;
  readonly app: Pick<AppBoundary, "relaunch" | "openPath">;
  readonly dialog: Pick<DialogBoundary, "showDialog">;
  readonly fs: Pick<FileSystemBoundary, "writeFile">;
  readonly logger: Logger;
}

interface SettingKey {
  readonly key: string;
  readonly def: PersistedKeyDefinition<unknown>;
  readonly control: SettingsControl;
}

// =============================================================================
// Key derivation
// =============================================================================

interface KeyParts {
  readonly group: string;
  readonly subheading: string | undefined;
  readonly label: string;
}

/**
 * Group / sub-heading / label from a dot-separated key, verbatim:
 *   "agent"                        -> General          / -        / agent
 *   "sidebar.width"                -> sidebar          / -        / width
 *   "experimental.youtrack.token"  -> experimental     / youtrack / token
 *   "experimental.busy-...-shell"  -> experimental     / -        / busy-...-shell
 */
function keyParts(key: string): KeyParts {
  const segments = key.split(".");
  if (segments.length === 1) {
    return { group: GENERAL_GROUP, subheading: undefined, label: segments[0]! };
  }
  if (segments.length === 2) {
    return { group: segments[0]!, subheading: undefined, label: segments[1]! };
  }
  return { group: segments[0]!, subheading: segments[1]!, label: segments.slice(2).join(".") };
}

// =============================================================================
// Value <-> field encoding
// =============================================================================

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Whether the key accepts null (so an empty text field can mean "unset"). */
function isNullable(def: PersistedKeyDefinition<unknown>): boolean {
  return def.validate(null) !== undefined;
}

function csvHas(value: unknown, option: string): boolean {
  if (typeof value !== "string") return false;
  return value.split(",").includes(option);
}

// =============================================================================
// Module
// =============================================================================

export function createSettingsModule(deps: SettingsModuleDeps): {
  module: IntentModule;
  openSettings: () => void;
} {
  const { ui, config, app, dialog, fs, logger } = deps;

  let activeHandle: DialogHandle | null = null;
  /** Effective value per key when the dialog opened, for the restart-note diff. */
  let openValues: Record<string, unknown> = {};
  /**
   * Values set programmatically (by the file picker) that aren't yet persisted
   * and don't come from the renderer's field data. Merged into each row's
   * controlled value so a pick shows up immediately; persisted on Save, cleared
   * on reset. Keyed by config key.
   */
  let pickedValues: Record<string, string | null> = {};
  /** Latest renderer field data (from onChange), so a pick can rebuild without losing edits. */
  let latestData: Record<string, string> | undefined;

  /** Settings-eligible keys (has a control, not excluded, not deprecated), sorted. */
  function settingKeys(): SettingKey[] {
    const out: SettingKey[] = [];
    for (const [key, def] of config.getDefinitions()) {
      if (def.deprecated || def.settingsControl === undefined || EXCLUDED_KEYS.has(key)) continue;
      out.push({ key, def, control: def.settingsControl });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Decode the field data for one key into its typed value; undefined = invalid. */
  function decode(entry: SettingKey, data: Record<string, string>): unknown {
    const { key, def, control } = entry;
    switch (control.kind) {
      case "boolean":
        return data[key] === "true";
      case "number": {
        const raw = data[key] ?? "";
        if (raw.trim() === "") return undefined;
        return def.validate(Number(raw));
      }
      case "string":
      case "path": {
        const raw = data[key] ?? "";
        if (raw === "" && isNullable(def)) return def.validate(null);
        return def.validate(raw);
      }
      case "enum": {
        const raw = data[key] ?? "";
        if (raw === "" && control.nullable) return def.validate(null);
        return def.validate(raw);
      }
      case "enum-list": {
        const selected = control.options.filter((opt) => data[`${key}::${opt}`] === "true");
        return def.validate(selected.slice().sort().join(","));
      }
      case "guarded-text": {
        const on = data[`${key}${GUARD_ON_SUFFIX}`] === "true";
        if (!on) return def.validate(control.offValue);
        const text = data[key] ?? "";
        return def.validate(text === "" ? control.onEmptyValue : control.fromText(text));
      }
    }
  }

  /** The value-bearing fields for one key, seeded from `current`, with `error`. */
  function fieldsFor(
    entry: SettingKey,
    current: unknown,
    liveData: Record<string, string> | undefined,
    error: string | undefined
  ): SettingRowField[] {
    const { key, def, control } = entry;
    const masked = def.redact === true;
    switch (control.kind) {
      case "boolean":
        return [{ type: "checkbox", id: key, value: current === true, changeEvent: true }];
      case "number":
      case "string":
      case "path":
        return [
          {
            type: "input",
            id: key,
            // Controlled value (not initialValue) so a reset/rebuild can push the
            // default back into the field; typing between pushes is preserved.
            value: asString(current),
            changeEvent: true,
            ...(masked && { masked: true }),
            ...(error !== undefined && { error }),
          },
        ];
      case "enum": {
        const items = control.options.map((o) => ({ value: o.value, label: o.label }));
        const suggestions = control.nullable
          ? [{ items: [{ value: "", label: "(default)" }, ...items] }]
          : [{ items }];
        return [
          {
            type: "dropdown",
            id: key,
            searchable: false,
            changeEvent: true,
            suggestions,
            value: asString(current),
          },
        ];
      }
      case "enum-list":
        return control.options.map((opt) => ({
          type: "checkbox" as const,
          id: `${key}::${opt}`,
          label: opt,
          value: csvHas(current, opt),
          changeEvent: true,
        }));
      case "guarded-text": {
        const state = control.toText(current);
        const on = liveData ? liveData[`${key}${GUARD_ON_SUFFIX}`] === "true" : state.active;
        return [
          {
            type: "checkbox",
            id: `${key}${GUARD_ON_SUFFIX}`,
            label: "Enabled",
            value: state.active,
            changeEvent: true,
          },
          {
            type: "input",
            id: key,
            value: state.text,
            disabled: !on,
            changeEvent: true,
            ...(masked && { masked: true }),
            ...(error !== undefined && { error }),
          },
        ];
      }
    }
  }

  /**
   * Build the full dialog config. `liveData` (present after a field change)
   * drives validation, guard enable/disable, and the restart-note diff.
   */
  function buildConfig(liveData?: Record<string, string>): {
    config: DialogConfig;
    invalidCount: number;
  } {
    const sections: DialogSection[] = [];
    let invalidCount = 0;
    let lastGroup: string | undefined;
    let lastSubheading: string | undefined;

    for (const entry of settingKeys()) {
      const { key, def } = entry;
      const parts = keyParts(key);
      if (parts.group !== lastGroup) {
        sections.push({ type: "text", content: parts.group, style: "heading" });
        lastGroup = parts.group;
        lastSubheading = undefined;
      }
      if (parts.subheading !== undefined && parts.subheading !== lastSubheading) {
        sections.push({
          type: "text",
          content: parts.subheading,
          style: "subheading",
          indent: 1,
        });
        lastSubheading = parts.subheading;
      }

      const current = key in pickedValues ? pickedValues[key] : config.getEffective()[key];
      const source = config.getSource(key);

      // Live validation from the latest field values.
      let error: string | undefined;
      if (liveData) {
        const decoded = decode(entry, liveData);
        if (decoded === undefined) {
          error = def.validValues ? `Invalid value (expected ${def.validValues})` : "Invalid value";
          invalidCount += 1;
        }
      }

      // Restart note: shown when a restart-scoped key's buffered value differs
      // from its value when the dialog opened.
      const applies = def.applies ?? "restart";
      let note: string | undefined;
      if (liveData && applies !== "live" && error === undefined) {
        const decoded = decode(entry, liveData);
        if (decoded !== undefined && !valuesEqual(decoded, openValues[key])) {
          note = "Restart to apply";
        }
      }

      const badge = sourceBadge(source);
      // Reset is offered only when the key is set in config.json ("user") and its
      // value differs from the default — resetting removes it from config.json.
      const resettable = source === "user" && !valuesEqual(current, def.default);
      const row: Extract<DialogSection, { type: "setting-row" }> = {
        type: "setting-row",
        label: parts.label,
        fields: fieldsFor(entry, current, liveData, error),
        indent: parts.subheading !== undefined ? 2 : 1,
        ...(def.description !== undefined && { description: def.description }),
        ...(badge !== undefined && { badge }),
        ...(note !== undefined && { note }),
        ...(entry.control.kind === "path" && {
          action: { id: `${PICK_PREFIX}${key}`, label: "Browse…", icon: "folder" },
        }),
        ...(resettable && { resetId: `${RESET_PREFIX}${key}` }),
      };
      sections.push(row);
    }

    const saveDisabled = invalidCount > 0;
    sections.push({
      type: "group",
      reverse: true,
      items: [
        {
          type: "button",
          id: ACTION_SAVE,
          label: "Save",
          variant: "primary",
          disabled: saveDisabled,
        },
        {
          type: "button",
          id: ACTION_SAVE_RESTART,
          label: "Save & Restart",
          variant: "secondary",
          disabled: saveDisabled,
        },
        {
          type: "button",
          id: ACTION_CANCEL,
          label: "Cancel",
          variant: "secondary",
          role: "cancel",
        },
        {
          type: "button",
          id: ACTION_RESET_ALL,
          label: "Reset all to defaults",
          variant: "secondary",
        },
      ],
    });

    return { config: { sections, layout: "form", modal: true }, invalidCount };
  }

  /** Small source badge; only env/CLI overrides are noteworthy. */
  function sourceBadge(source: ConfigSource): string | undefined {
    return source === "env" || source === "cli" ? source : undefined;
  }

  function valuesEqual(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
  }

  /** File-type filters for the picker: the key's extensions plus an All-Files fallback. */
  function pickerFilters(extensions: readonly string[] | undefined) {
    if (!extensions || extensions.length === 0) return undefined;
    return [
      { name: extensions.map((e) => `.${e}`).join(", "), extensions: [...extensions] },
      { name: "All Files", extensions: ["*"] },
    ];
  }

  /**
   * Run the native file picker (save mode, so the user can name a new file) for a
   * path key. When the chosen path is new, atomically seed the key's template and
   * open the file in the OS default app; when it already exists, adopt the path
   * untouched. The chosen path is buffered (persisted on Save). Returns true when
   * a path was chosen so the caller rebuilds the dialog.
   */
  async function pickPath(key: string): Promise<boolean> {
    const entry = settingKeys().find((e) => e.key === key);
    if (!entry || entry.control.kind !== "path") return false;
    const { control } = entry;

    const current = key in pickedValues ? pickedValues[key] : config.getEffective()[key];
    const filters = pickerFilters(control.extensions);
    const result = await dialog.showDialog({
      mode: "save",
      ...(typeof current === "string" && current !== "" && { defaultPath: current }),
      ...(filters !== undefined && { filters }),
    });
    if (result.canceled || result.filePaths.length === 0) return false;
    const picked = result.filePaths[0]!.toString();

    // Seed the template only when the file is new (exclusive write → EEXIST means
    // it already exists, so adopt it untouched). Open a freshly-created file so
    // the user can edit it right away.
    if (control.template !== undefined) {
      try {
        await fs.writeFile(picked, control.template, { exclusive: true });
        await app.openPath(picked);
      } catch (error) {
        if (!(error instanceof FileSystemError && error.fsCode === "EEXIST")) {
          logger.warn("Failed to seed template file", {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    pickedValues[key] = picked;
    if (latestData) latestData[key] = picked;
    return true;
  }

  /** Persist every changed key from the buffered field data. */
  async function save(data: Record<string, string>): Promise<boolean> {
    for (const entry of settingKeys()) {
      const decoded = decode(entry, data);
      if (decoded === undefined) {
        logger.warn("Skipping invalid setting on save", { key: entry.key });
        continue;
      }
      if (valuesEqual(decoded, config.getEffective()[entry.key])) continue;
      try {
        await config.set(entry.key, decoded);
      } catch (error) {
        logger.warn("Failed to persist setting", {
          key: entry.key,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    return true;
  }

  function openSettings(): void {
    if (activeHandle) return;

    openValues = { ...config.getEffective() };
    pickedValues = {};
    latestData = undefined;
    const handle = ui.dialog(buildConfig().config);
    activeHandle = handle;

    const close = (): void => {
      handle.close();
      activeHandle = null;
    };

    handle.onChange((event) => {
      // Rebuild with the latest field values so validation, guard enable/disable
      // and restart notes reflect the edit.
      latestData = { ...event.data };
      handle.update(buildConfig(event.data).config);
    });

    handle.onEvent((event) => {
      const data = event.data ?? {};
      if (event.actionId === ACTION_CANCEL) {
        close();
        return;
      }
      if (event.actionId === ACTION_RESET_ALL) {
        void (async () => {
          for (const entry of settingKeys()) {
            if (config.getSource(entry.key) !== "default") await config.reset(entry.key);
          }
          pickedValues = {};
          openValues = { ...config.getEffective() };
          handle.update(buildConfig().config);
        })();
        return;
      }
      if (event.actionId.startsWith(RESET_PREFIX)) {
        const key = event.actionId.slice(RESET_PREFIX.length);
        void (async () => {
          await config.reset(key);
          delete pickedValues[key];
          openValues = { ...config.getEffective() };
          handle.update(buildConfig().config);
        })();
        return;
      }
      if (event.actionId.startsWith(PICK_PREFIX)) {
        const key = event.actionId.slice(PICK_PREFIX.length);
        void (async () => {
          const picked = await pickPath(key);
          if (picked) handle.update(buildConfig(latestData).config);
        })();
        return;
      }
      if (event.actionId === ACTION_SAVE || event.actionId === ACTION_SAVE_RESTART) {
        void (async () => {
          // Merge buffered picks (not necessarily reflected in the renderer data)
          // so a picked path persists even if the field hasn't re-reported it.
          const merged: Record<string, string> = { ...data };
          for (const [key, value] of Object.entries(pickedValues)) {
            merged[key] = value ?? "";
          }
          const ok = await save(merged);
          if (!ok) return;
          if (event.actionId === ACTION_SAVE_RESTART) {
            app.relaunch();
            return;
          }
          close();
        })();
        return;
      }
    });

    void handle.closed.then(() => {
      activeHandle = null;
    });
  }

  const module: IntentModule = {
    name: "settings",
    events: {
      [EVENT_SHORTCUT_KEY_PRESSED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { key } = (event as ShortcutKeyPressedEvent).payload;
          if (key === "s") openSettings();
        },
      },
    },
  };

  return { module, openSettings };
}
