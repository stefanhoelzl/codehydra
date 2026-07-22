/**
 * SettingsModule integration tests.
 *
 * Exercises the auto-populated settings dialog against a mock Config (registered
 * with real type builders, so settingsControl/validate are the production ones),
 * a mock dialog surface, and a mock AppBoundary: population + exclusions,
 * group/sub-heading derivation, control mapping, buffered save, Save & Restart
 * relaunch, live-validation gating, guarded-text decode, and reset.
 */

import { describe, it, expect, vi } from "vitest";
import { createSettingsModule } from "./settings-module";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { createMockDialogManager } from "./presentation/dialog-manager.state-mock";
import { createAppBoundaryMock } from "../boundaries/shell/app.state-mock";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";
import {
  storeBoolean,
  storeCustom,
  storeEnum,
  storeEnumList,
  storeNumber,
  storeString,
  storeText,
} from "../boundaries/platform/store-definition";
import type { Config } from "../boundaries/platform/config";
import type { UiPresenter } from "./presentation/presentation-module";
import type { DialogConfig, DialogSection } from "../shared/dialog-types";
import { EVENT_SHORTCUT_KEY_PRESSED, type ShortcutKeyPressedEvent } from "../intents/shortcut-key";

// =============================================================================
// Helpers
// =============================================================================

/** Register the representative key set on a mock config. */
function registerKeys(config: Config): void {
  config.register("agent", {
    default: "claude",
    description: "Agent selection",
    applies: "restart",
    ...storeEnum(["claude", "opencode"]),
  });
  config.register("telemetry.enabled", {
    default: true,
    description: "Enable telemetry",
    applies: "live",
    ...storeBoolean(),
  });
  config.register("help", { default: false, ...storeBoolean() });
  config.register("sidebar.width", {
    default: 250,
    applies: "live",
    ...storeNumber({ min: 250, max: 100000 }),
  });
  config.register("log.output", { default: "file", ...storeEnumList(["file", "console"]) });
  config.register("experimental.youtrack.token", {
    default: null,
    redact: true,
    ...storeString({ nullable: true }),
  });
  // A neutral guarded-text key, purely to exercise the settings dialog's
  // checkbox-guarded-text control rendering/decoding.
  config.register("experimental.guarded-example", {
    default: true,
    ...storeCustom<boolean | readonly string[]>({
      parse: (s) => (s === "true" ? true : s === "false" ? false : undefined),
      validate: (v) =>
        typeof v === "boolean" || (Array.isArray(v) && v.every((p) => typeof p === "string"))
          ? (v as boolean | readonly string[])
          : undefined,
      validValues: "true|false|[<text>, ...]",
      settingsControl: {
        kind: "guarded-text",
        offValue: false,
        onEmptyValue: true,
        fromText: (text: string) =>
          text
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        toText: (value: unknown) => {
          if (value === false) return { active: false, text: "" };
          if (value === true) return { active: true, text: "" };
          if (Array.isArray(value)) return { active: true, text: value.join(", ") };
          return { active: false, text: "" };
        },
      },
    }),
  });
  config.register("experimental.youtrack.template", {
    default: null,
    description: "Liquid template for youtrack auto-workspaces",
    applies: "live",
    omit: true,
    ...storeText({
      nullable: true,
      rows: 14,
      helpPanel: TEMPLATE_HELP,
      helpLabel: TEMPLATE_HELP_LABEL,
    }),
  });
}

const TEMPLATE_HELP = "Available fields:\n  summary\n  description";
const TEMPLATE_HELP_LABEL = "Available fields and front-matter keys";

function setup(): {
  openSettings: () => void;
  config: Config;
  dialogs: ReturnType<typeof createMockDialogManager>;
  app: ReturnType<typeof createAppBoundaryMock>;
} {
  const config = createMockConfig();
  registerKeys(config);
  const dialogs = createMockDialogManager();
  const app = createAppBoundaryMock({ platform: "linux" });
  const { openSettings } = createSettingsModule({
    ui: dialogs.ui as unknown as UiPresenter,
    config,
    app,
    logger: createMockLogger(),
  });
  return { openSettings, config, dialogs, app };
}

/** Flush pending microtasks (the module's async save/reset handlers). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sectionsOf(cfg: DialogConfig): readonly DialogSection[] {
  return cfg.sections;
}

function rowByLabel(
  cfg: DialogConfig,
  label: string
): Extract<DialogSection, { type: "setting-row" }> | undefined {
  return cfg.sections.find(
    (s): s is Extract<DialogSection, { type: "setting-row" }> =>
      s.type === "setting-row" && s.label === label
  );
}

function headings(cfg: DialogConfig): string[] {
  return cfg.sections
    .filter(
      (s): s is Extract<DialogSection, { type: "text" }> =>
        s.type === "text" && s.style === "heading"
    )
    .map((s) => s.content);
}

function footerButtonIds(cfg: DialogConfig): string[] {
  const group = cfg.sections.find(
    (s): s is Extract<DialogSection, { type: "group" }> => s.type === "group"
  );
  return (group?.items ?? []).flatMap((i) => (i.type === "button" ? [i.id] : []));
}

function saveDisabled(cfg: DialogConfig): boolean {
  const group = cfg.sections.find(
    (s): s is Extract<DialogSection, { type: "group" }> => s.type === "group"
  );
  const save = group?.items.find((i) => i.type === "button" && i.id === "save");
  return save?.type === "button" ? save.disabled === true : false;
}

// =============================================================================
// Tests
// =============================================================================

describe("SettingsModule — population", () => {
  it("opens a modal form dialog with a row per eligible key", () => {
    const { openSettings, dialogs } = setup();
    openSettings();

    expect(dialogs.handles).toHaveLength(1);
    expect(dialogs.lastHandle!.kind).toBe("modal");
    const cfg = dialogs.lastHandle!.config;
    expect(cfg.layout).toBe("form");

    expect(rowByLabel(cfg, "agent")).toBeDefined();
    expect(rowByLabel(cfg, "enabled")).toBeDefined(); // telemetry.enabled
    expect(rowByLabel(cfg, "width")).toBeDefined();
    expect(rowByLabel(cfg, "token")).toBeDefined();
  });

  it("excludes the `help` pseudo-key", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    expect(rowByLabel(dialogs.lastHandle!.config, "help")).toBeUndefined();
  });

  it("derives group headings from the key prefix (dotless → General)", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const hs = headings(dialogs.lastHandle!.config);
    expect(hs).toContain("General"); // agent, telemetry.enabled
    expect(hs).toContain("sidebar");
    expect(hs).toContain("log");
    expect(hs).toContain("experimental");
  });

  it("renders a sub-heading for a three-segment key", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const sub = sectionsOf(dialogs.lastHandle!.config).find(
      (s) => s.type === "text" && s.style === "subheading" && s.content === "youtrack"
    );
    expect(sub).toBeDefined();
  });

  it("maps controls: boolean→checkbox, enum→dropdown, number/string→input, enum-list→checkboxes", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const cfg = dialogs.lastHandle!.config;
    expect(rowByLabel(cfg, "enabled")!.fields[0]!.type).toBe("checkbox");
    expect(rowByLabel(cfg, "agent")!.fields[0]!.type).toBe("dropdown");
    expect(rowByLabel(cfg, "width")!.fields[0]!.type).toBe("input");
    // enum-list → one checkbox per option
    const output = rowByLabel(cfg, "output")!;
    expect(output.fields).toHaveLength(2);
    expect(output.fields.every((f) => f.type === "checkbox")).toBe(true);
  });

  it("renders a redact key as a masked input", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const token = rowByLabel(dialogs.lastHandle!.config, "token")!;
    expect(token.fields[0]).toMatchObject({ type: "input", masked: true });
  });

  it("renders the guarded-text union as a checkbox + input", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const guarded = rowByLabel(dialogs.lastHandle!.config, "guarded-example")!;
    expect(guarded.fields.map((f) => f.type)).toEqual(["checkbox", "input"]);
  });

  it("footer offers Save / Save & Restart / Cancel / Reset all", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    expect(footerButtonIds(dialogs.lastHandle!.config)).toEqual([
      "save",
      "save-restart",
      "cancel",
      "reset-all",
    ]);
  });
});

describe("SettingsModule — save", () => {
  it("persists only changed keys on Save, then closes", async () => {
    const { openSettings, config, dialogs } = setup();
    const setSpy = vi.spyOn(config, "set");
    openSettings();
    const handle = dialogs.lastHandle!;

    // agent unchanged (claude), telemetry toggled off, width changed.
    handle.emitAction("save", {
      agent: "claude",
      "telemetry.enabled": "false",
      "sidebar.width": "300",
      "log.output": "file",
      "experimental.youtrack.token": "",
      "experimental.guarded-example::on": "true",
      "experimental.guarded-example": "",
    });
    await flush();

    expect(setSpy).toHaveBeenCalledWith("telemetry.enabled", false);
    expect(setSpy).toHaveBeenCalledWith("sidebar.width", 300);
    expect(setSpy).not.toHaveBeenCalledWith("agent", expect.anything());
    expect(handle.closed).toBe(true);
  });

  it("Save & Restart persists then relaunches", async () => {
    const { openSettings, config, dialogs, app } = setup();
    const setSpy = vi.spyOn(config, "set");
    openSettings();
    dialogs.lastHandle!.emitAction("save-restart", {
      agent: "opencode",
      "telemetry.enabled": "true",
      "sidebar.width": "250",
      "log.output": "file",
      "experimental.youtrack.token": "",
      "experimental.guarded-example::on": "true",
      "experimental.guarded-example": "",
    });
    await flush();

    expect(setSpy).toHaveBeenCalledWith("agent", "opencode");
    expect(app).toHaveRelaunchCount(1);
  });

  it("Cancel closes without persisting", async () => {
    const { openSettings, config, dialogs } = setup();
    const setSpy = vi.spyOn(config, "set");
    openSettings();
    dialogs.lastHandle!.emitAction("cancel", {});
    expect(setSpy).not.toHaveBeenCalled();
    expect(dialogs.lastHandle!.closed).toBe(true);
  });
});

describe("SettingsModule — validation", () => {
  it("disables Save while a field is invalid", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const handle = dialogs.lastHandle!;
    expect(saveDisabled(handle.config)).toBe(false);

    handle.emitChange("sidebar.width", {
      agent: "claude",
      "telemetry.enabled": "true",
      "sidebar.width": "abc",
      "log.output": "file",
      "experimental.youtrack.token": "",
    });

    expect(saveDisabled(handle.config)).toBe(true);
  });
});

describe("SettingsModule — reset", () => {
  it("Reset all to defaults reverts every non-default key", async () => {
    const { openSettings, config, dialogs } = setup();
    await config.set("sidebar.width", 400);
    await config.set("telemetry.enabled", false);
    const resetSpy = vi.spyOn(config, "reset");
    openSettings();

    dialogs.lastHandle!.emitAction("reset-all", {});
    await flush();

    expect(resetSpy).toHaveBeenCalledWith("sidebar.width");
    expect(resetSpy).toHaveBeenCalledWith("telemetry.enabled");
  });

  it("indents rows by nesting depth (group vs sub-group)", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const cfg = dialogs.lastHandle!.config;
    expect(rowByLabel(cfg, "width")!.indent).toBe(1); // sidebar.width
    expect(rowByLabel(cfg, "token")!.indent).toBe(2); // experimental.youtrack.token
  });

  it("offers per-row reset only for user-set, non-default keys, and resets on click", async () => {
    const { openSettings, config, dialogs } = setup();
    await config.set("sidebar.width", 400); // user-set, deviates from default
    const resetSpy = vi.spyOn(config, "reset");
    openSettings();
    const cfg = dialogs.lastHandle!.config;

    expect(rowByLabel(cfg, "width")!.resetId).toBe("reset:sidebar.width");
    expect(rowByLabel(cfg, "agent")!.resetId).toBeUndefined(); // still default

    dialogs.lastHandle!.emitAction("reset:sidebar.width", {});
    await flush();
    expect(resetSpy).toHaveBeenCalledWith("sidebar.width");
  });
});

describe("SettingsModule — text (inline template) control", () => {
  it("renders a multiline, unmasked input with a help panel/label and no action", () => {
    const { openSettings, dialogs } = setup();
    openSettings();
    const row = rowByLabel(dialogs.lastHandle!.config, "template")!;
    const field = row.fields[0] as { type: string; multiline?: boolean; masked?: boolean };
    expect(field.type).toBe("input");
    expect(field.multiline).toBe(true);
    // omit (not redact) → the editor is shown in the clear.
    expect(field.masked).toBeUndefined();
    expect(row.helpPanel).toBe(TEMPLATE_HELP);
    expect(row.helpLabel).toBe(TEMPLATE_HELP_LABEL);
    expect(row.action).toBeUndefined();
  });

  it("persists edited template content on save", async () => {
    const { openSettings, dialogs, config } = setup();
    openSettings();
    const next = "---\nname: {{ summary }}\n---\nWork on {{ summary }}";
    dialogs.lastHandle!.emitAction("save", { "experimental.youtrack.template": next });
    await flush();
    expect(config.getEffective()["experimental.youtrack.template"]).toBe(next);
  });

  it("treats an empty editor as unset (null)", async () => {
    const { openSettings, dialogs, config } = setup();
    openSettings();
    // Seed a value, then clear it.
    await config.set("experimental.youtrack.template", "something");
    dialogs.lastHandle!.emitAction("save", { "experimental.youtrack.template": "" });
    await flush();
    expect(config.getEffective()["experimental.youtrack.template"]).toBeNull();
  });
});

describe("SettingsModule — shortcut", () => {
  it("opens on the 's' shortcut key", async () => {
    const { config, dialogs, app } = setup();
    const { module } = createSettingsModule({
      ui: dialogs.ui as unknown as UiPresenter,
      config,
      app,
      logger: createMockLogger(),
    });
    const event: ShortcutKeyPressedEvent = {
      type: EVENT_SHORTCUT_KEY_PRESSED,
      payload: { key: "s" },
    };
    await module.events![EVENT_SHORTCUT_KEY_PRESSED]!.handler(event);
    expect(dialogs.handles).toHaveLength(1);
  });
});
