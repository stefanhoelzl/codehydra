/**
 * A plugin's settings: merging what its documents declare, and turning the
 * user's values into its scripts' environment.
 */

import { describe, it, expect } from "vitest";
import { mergeSettings, settingEnvName, settingsEnv, type Setting } from "./plugin-config";
import { parseManifest } from "./manifest";

const SETTINGS: Record<string, Setting> = {
  region: { type: "enum", values: ["eu", "us"], default: "eu" },
  token: { type: "string", required: true, secret: true },
  retries: { type: "number" },
  "dry-run": { type: "boolean", default: false },
};

describe("settingEnvName", () => {
  it("upper-cases and turns - into _", () => {
    expect(settingEnvName("dry-run")).toBe("CH_CONFIG_DRY_RUN");
  });
});

describe("settingsEnv", () => {
  it("delivers values and defaults as strings, leaving unset optional ones out", () => {
    expect(settingsEnv(SETTINGS, { token: "t", region: "us" })).toEqual({
      CH_CONFIG_REGION: "us",
      CH_CONFIG_TOKEN: "t",
      CH_CONFIG_DRY_RUN: "false",
    });
    expect(settingsEnv(SETTINGS, { token: "t", retries: 3 })).toMatchObject({
      CH_CONFIG_RETRIES: "3",
    });
  });

  it.each([
    ["a required setting missing", {}, /config\.token is required/],
    ["a wrong type", { token: 1 }, /config\.token must be a string, not a number/],
    ["a value outside the enum", { token: "t", region: "ap" }, /must be one of eu, us/],
    ["a boolean given text", { token: "t", "dry-run": "no" }, /must be true or false/],
    ["a setting not declared", { token: "t", regoin: "us" }, /sets regoin, which the plugin/],
  ])("refuses %s", (_what, values, message) => {
    expect(() => settingsEnv(SETTINGS, values)).toThrow(message);
  });
});

describe("mergeSettings", () => {
  it("merges the applying documents' sections", () => {
    expect(mergeSettings([{ a: { type: "string" } }, { b: { type: "number" } }])).toEqual({
      a: { type: "string" },
      b: { type: "number" },
    });
  });

  it("refuses a setting declared twice, by name or by environment variable", () => {
    expect(() => mergeSettings([{ a: { type: "string" } }, { a: { type: "string" } }])).toThrow(
      /config\.a is declared twice/
    );
    expect(() =>
      mergeSettings([{ "a-b": { type: "string" } }, { a_b: { type: "string" } }])
    ).toThrow(/both CH_CONFIG_A_B/);
  });
});

describe("a manifest's config section", () => {
  it("is read into each document's settings", () => {
    const [doc] = parseManifest(
      "config:\n  region:\n    type: enum\n    values: [eu, us]\n    default: eu\n"
    );
    expect(doc!.settings).toEqual({
      region: { type: "enum", values: ["eu", "us"], default: "eu" },
    });
  });

  it.each([
    ["an unknown type", "config:\n  a: {type: list}\n"],
    ["an unknown key", "config:\n  a: {type: string, defualt: x}\n"],
    ["a default of the wrong type", "config:\n  a: {type: number, default: x}\n"],
    [
      "an enum default not among its values",
      "config:\n  a: {type: enum, values: [x], default: y}\n",
    ],
    ["an unusable name", "config:\n  1a: {type: string}\n"],
  ])("refuses %s", (_what, text) => {
    expect(() => parseManifest(text)).toThrow(/document 1: config/);
  });
});
