/**
 * A plugin's settings: what its author declares, and what its user sets.
 *
 * A manifest may declare settings in a `config:` section — each a flat scalar
 * with a type, an optional default, whether it is required, a description and
 * whether it is a secret:
 *
 *   config:
 *     region:
 *       type: enum
 *       values: [eu, us]
 *       default: eu
 *     token:
 *       type: string
 *       required: true
 *       secret: true
 *
 * The values are the user's, not the plugin's: they live in `plugins.config`
 * (sources.ts), under the entry the plugin comes from, keyed by plugin name.
 * They reach every script the plugin runs as `CH_CONFIG_<KEY>` — environment
 * rather than stdin, because a run's stdin is written to its log and the
 * environment never is.
 *
 * A value that does not fit — a required one missing, a wrong type, a key the
 * plugin does not declare — makes the plugin unable to run, like an invalid
 * manifest: a half-configured plugin should not half-run.
 */

import { z } from "zod/v4";

/** Setting names become environment variable names, so they stay plain. */
export const SETTING_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The prefix of every setting's environment variable. */
export const SETTING_ENV_PREFIX = "CH_CONFIG_";

/** A value a user can give a setting. */
export type SettingValue = string | number | boolean;

const common = {
  description: z.string().optional().describe("What the setting is for, for its user."),
  required: z
    .boolean()
    .optional()
    .describe("The plugin cannot run until the setting has a value (default: false)."),
  secret: z
    .boolean()
    .optional()
    .describe("The value is a credential: kept out of CodeHydra's own output (default: false)."),
};

const stringSetting = z
  .object({ type: z.literal("string"), default: z.string().optional(), ...common })
  .strict();
const numberSetting = z
  .object({ type: z.literal("number"), default: z.number().optional(), ...common })
  .strict();
const booleanSetting = z
  .object({ type: z.literal("boolean"), default: z.boolean().optional(), ...common })
  .strict();
const enumSetting = z
  .object({
    type: z.literal("enum"),
    values: z.array(z.string().min(1)).min(1).describe("The values the setting may take."),
    default: z.string().optional(),
    ...common,
  })
  .strict()
  .refine((setting) => setting.default === undefined || setting.values.includes(setting.default), {
    message: "the default must be one of the values",
    path: ["default"],
  });

export const settingSchema = z.discriminatedUnion("type", [
  stringSetting,
  numberSetting,
  booleanSetting,
  enumSetting,
]);

export type Setting = z.infer<typeof settingSchema>;

/** A manifest document's `config:` section. */
export const settingsSchema = z
  .record(
    z.string().regex(SETTING_NAME, {
      error: "setting names use letters, digits, - and _ (and start with a letter)",
    }),
    settingSchema
  )
  .describe(
    "Settings the plugin's user gives values to in plugins.config; each reaches the " +
      "scripts as CH_CONFIG_<NAME> (upper-cased, - becomes _)."
  );

/** The environment variable a setting is delivered in. */
export function settingEnvName(name: string): string {
  return `${SETTING_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Merge the `config:` sections of the documents that apply, in file order.
 * Throws naming the first setting declared twice — by name, or by two names
 * that become one environment variable (`a-b` and `a_b`).
 */
export function mergeSettings(
  sections: readonly Readonly<Record<string, Setting>>[]
): Record<string, Setting> {
  const merged: Record<string, Setting> = {};
  const byEnv = new Map<string, string>();
  for (const section of sections) {
    for (const [name, setting] of Object.entries(section)) {
      const envName = settingEnvName(name);
      const previous = byEnv.get(envName);
      if (previous !== undefined) {
        throw new Error(
          previous === name
            ? `config.${name} is declared twice`
            : `config.${previous} and config.${name} are both ${envName}`
        );
      }
      byEnv.set(envName, name);
      merged[name] = setting;
    }
  }
  return merged;
}

function typeName(value: SettingValue): string {
  return typeof value;
}

/** Check one value against its setting. Returns why it does not fit, or undefined. */
function mismatch(setting: Setting, value: SettingValue): string | undefined {
  switch (setting.type) {
    case "string":
      return typeof value === "string" ? undefined : `must be a string, not a ${typeName(value)}`;
    case "number":
      return typeof value === "number" ? undefined : `must be a number, not a ${typeName(value)}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `must be true or false`;
    case "enum":
      return typeof value === "string" && setting.values.includes(value)
        ? undefined
        : `must be one of ${setting.values.join(", ")}`;
  }
}

/**
 * The environment a plugin's settings give its scripts.
 *
 * Throws naming the first value that does not fit: one for a setting the
 * plugin does not declare (a typo, or a setting it dropped), one of the wrong
 * type, or a required setting with neither a value nor a default.
 */
export function settingsEnv(
  settings: Readonly<Record<string, Setting>>,
  values: Readonly<Record<string, SettingValue>>
): Record<string, string> {
  for (const name of Object.keys(values)) {
    if (settings[name] === undefined) {
      throw new Error(`plugins.config sets ${name}, which the plugin does not declare`);
    }
  }
  const env: Record<string, string> = {};
  for (const [name, setting] of Object.entries(settings)) {
    const value = values[name] ?? setting.default;
    if (value === undefined) {
      if (setting.required === true) {
        throw new Error(`config.${name} is required: set it in plugins.config`);
      }
      continue;
    }
    const wrong = mismatch(setting, value);
    if (wrong !== undefined) throw new Error(`config.${name} ${wrong}`);
    env[settingEnvName(name)] = String(value);
  }
  return env;
}
