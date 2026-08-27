/**
 * Focused tests for argv parsing.
 *
 * Pure input/output: given a schema and arguments, what payload does the CLI
 * send? Covers the three ways a field can be supplied and their precedence.
 */

import { describe, it, expect } from "vitest";
import { parseArgs, UsageError, type InputSchema } from "./args";

const DELETE: InputSchema = {
  properties: {
    workspacePath: { type: "string" },
    keepBranch: { type: "boolean" },
    ignoreWarnings: { type: "boolean" },
    wait: { type: "boolean" },
  },
};

const MESSAGE: InputSchema = {
  properties: {
    message: { type: ["string", "null"] },
    options: { type: "array" },
    timeout: { type: "number" },
  },
};

const COMMAND: InputSchema = {
  properties: { command: { type: "string" }, args: { type: "array" } },
};

describe("parseArgs", () => {
  describe("flags", () => {
    it("sets a boolean field when the flag is present alone", () => {
      expect(parseArgs(["--keep-branch"], DELETE).input).toEqual({ keepBranch: true });
    });

    it("clears a boolean field with the no- form", () => {
      expect(parseArgs(["--no-wait"], DELETE).input).toEqual({ wait: false });
    });

    it("maps a kebab-case flag onto its camelCase field", () => {
      expect(parseArgs(["--ignore-warnings"], DELETE).input).toEqual({ ignoreWarnings: true });
    });

    it("reads a value from the next token", () => {
      expect(parseArgs(["--workspace-path", "/wt/a"], DELETE).input).toEqual({
        workspacePath: "/wt/a",
      });
    });

    it("reads a value given inline with =", () => {
      expect(parseArgs(["--workspace-path=/wt/a"], DELETE).input).toEqual({
        workspacePath: "/wt/a",
      });
    });

    it("coerces a number field", () => {
      expect(parseArgs(["--timeout", "30"], MESSAGE).input).toEqual({ timeout: 30 });
    });

    it("rejects a non-numeric value for a number field", () => {
      expect(() => parseArgs(["--timeout", "soon"], MESSAGE)).toThrow(UsageError);
    });

    it("builds an array by repeating the flag", () => {
      expect(parseArgs(["--options", "Yes", "--options", "No"], MESSAGE).input).toEqual({
        options: ["Yes", "No"],
      });
    });

    it("reports a missing value rather than swallowing the next flag", () => {
      expect(() => parseArgs(["--workspace-path"], DELETE)).toThrow(/expects a value/);
    });
  });

  describe("structured fields", () => {
    it("uses a JSON array as the whole field", () => {
      const { input } = parseArgs(
        ["--args", '[{"$vscode":"Uri","value":"file:///a.ts"}]'],
        COMMAND
      );
      expect(input).toEqual({ args: [{ $vscode: "Uri", value: "file:///a.ts" }] });
    });

    it("appends a JSON object as one element", () => {
      const { input } = parseArgs(["--args", '{"$vscode":"Uri","value":"file:///a.ts"}'], COMMAND);
      expect(input).toEqual({ args: [{ $vscode: "Uri", value: "file:///a.ts" }] });
    });

    it("reports malformed JSON against the flag that carried it", () => {
      expect(() => parseArgs(["--args", "{nope}"], COMMAND)).toThrow(/expects JSON/);
    });
  });

  describe("positionals", () => {
    it("fills declared fields in order", () => {
      const { input } = parseArgs(["a.ts", "b.ts"], { properties: {} }, ["left", "right"]);
      expect(input).toEqual({ left: "a.ts", right: "b.ts" });
    });

    it("allows fewer positionals than declared", () => {
      const { input } = parseArgs(["a.ts"], { properties: {} }, ["left", "right"]);
      expect(input).toEqual({ left: "a.ts" });
    });

    it("reports an argument past the declared list", () => {
      expect(() => parseArgs(["a", "b", "c"], { properties: {} }, ["left", "right"])).toThrow(
        /unexpected argument "c"/
      );
    });

    it("reports any argument for a command taking none", () => {
      expect(() => parseArgs(["oops"], DELETE)).toThrow(/unexpected argument "oops"/);
    });

    it("treats everything after -- as positional", () => {
      const { input } = parseArgs(["--", "--not-a-flag"], { properties: {} }, ["message"]);
      expect(input).toEqual({ message: "--not-a-flag" });
    });
  });

  describe("--input", () => {
    it("supplies the whole payload as JSON", () => {
      const { input } = parseArgs(['--input={"keepBranch":true,"wait":false}'], DELETE);
      expect(input).toEqual({ keepBranch: true, wait: false });
    });

    it("is overridden by an explicit flag", () => {
      const { input } = parseArgs(['--input={"keepBranch":true}', "--no-keep-branch"], DELETE);
      expect(input).toEqual({ keepBranch: false });
    });

    it("is overridden by a positional", () => {
      const { input } = parseArgs(['--input={"message":"from json"}', "from positional"], MESSAGE, [
        "message",
      ]);
      expect(input).toEqual({ message: "from positional" });
    });

    it("rejects a non-object payload", () => {
      expect(() => parseArgs(["--input", "[1,2]"], DELETE)).toThrow(/JSON object/);
      expect(() => parseArgs(["--input", "nope"], DELETE)).toThrow(/JSON object/);
    });
  });

  describe("global flags", () => {
    it("captures workspace, data-dir and help without treating them as input", () => {
      const { input, global } = parseArgs(
        ["--workspace", "/wt/a", "--data-dir", "/data", "--help"],
        DELETE
      );

      expect(input).toEqual({});
      expect(global).toEqual({ workspace: "/wt/a", dataDir: "/data", help: true });
    });

    it("records a forced output mode in both directions", () => {
      expect(parseArgs(["--json"], DELETE).global.json).toBe(true);
      expect(parseArgs(["--no-json"], DELETE).global.json).toBe(false);
    });

    it("leaves the output mode undecided when neither is given", () => {
      expect(parseArgs([], DELETE).global.json).toBeUndefined();
    });
  });
});
