/**
 * Focused tests for argv parsing.
 *
 * Pure input/output: given a schema and arguments, what payload does the CLI
 * send? Covers the three ways a field can be supplied and their precedence.
 */

import { describe, it, expect } from "vitest";
import { parseArgs, readFormat, UsageError, type InputSchema } from "./args";

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

    it("accepts true or false inline on a boolean flag", () => {
      expect(parseArgs(["--wait=false"], DELETE).input).toEqual({ wait: false });
      expect(parseArgs(["--wait=true"], DELETE).input).toEqual({ wait: true });
    });

    it("keeps a field whose own name starts with no-", () => {
      const schema: InputSchema = { properties: { noWait: { type: "boolean" } } };
      expect(parseArgs(["--no-wait"], schema).input).toEqual({ noWait: true });
    });
  });

  describe("unknown flags", () => {
    it("rejects a flag that is not a field of the operation", () => {
      expect(() => parseArgs(["--keep-brnach"], DELETE)).toThrow(/unknown flag "--keep-brnach"/);
    });

    it("rejects the removed --json and --no-json", () => {
      expect(() => parseArgs(["--json"], DELETE)).toThrow(/unknown flag "--json"/);
      expect(() => parseArgs(["--no-json"], DELETE)).toThrow(/unknown flag "--no-json"/);
    });

    it("rejects negating a field that is not boolean", () => {
      expect(() => parseArgs(["--no-timeout"], MESSAGE)).toThrow(/unknown flag "--no-timeout"/);
    });

    it("rejects an unknown short flag, pointing at --", () => {
      expect(() => parseArgs(["-5"], MESSAGE, ["message"])).toThrow(/after --/);
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
    it("captures workspace and help without treating them as input", () => {
      const { input, global } = parseArgs(["--workspace", "/wt/a", "--help"], DELETE);

      expect(input).toEqual({});
      expect(global).toEqual({ workspace: "/wt/a", help: true });
    });

    it("records the output format", () => {
      expect(parseArgs(["--format", "json"], DELETE).global.format).toBe("json");
      expect(parseArgs(["--format=text"], DELETE).global.format).toBe("text");
    });

    it("leaves the output format undecided when not given", () => {
      expect(parseArgs([], DELETE).global.format).toBeUndefined();
    });

    it("rejects an unknown format", () => {
      expect(() => parseArgs(["--format", "yaml"], DELETE)).toThrow(/json, text, auto/);
    });

    it("accepts --progress and --no-progress without treating them as input", () => {
      expect(parseArgs(["--progress", "--no-progress"], DELETE).input).toEqual({});
    });

    it("takes --project as global for a command without a project field", () => {
      const { input, global } = parseArgs(["--workspace", "ws0", "--project", "p0"], DELETE);

      expect(input).toEqual({});
      expect(global).toMatchObject({ workspace: "ws0", project: "p0" });
    });

    it("leaves --project to a command that has a project field of its own", () => {
      const create: InputSchema = {
        properties: { name: { type: "string" }, project: { type: "string" } },
      };
      const { input, global } = parseArgs(["--project", "p0"], create);

      expect(input).toEqual({ project: "p0" });
      expect(global.project).toBeUndefined();
    });

    it("lets a global flag win over a field of the same name", () => {
      const schema: InputSchema = { properties: { workspace: { type: "string" } } };
      const { input, global } = parseArgs(["--workspace", "/wt/a"], schema, ["workspace"]);
      expect(input).toEqual({});
      expect(global.workspace).toBe("/wt/a");
    });
  });
});

describe("readFormat", () => {
  it("defaults to auto", () => {
    expect(readFormat(["ws", "status"])).toBe("auto");
  });

  it("reads either spelling, ignoring other flags", () => {
    expect(readFormat(["ws", "status", "--bogus", "--format", "json"])).toBe("json");
    expect(readFormat(["--format=text"])).toBe("text");
  });

  it("lets the last occurrence win", () => {
    expect(readFormat(["--format", "json", "--format", "auto"])).toBe("auto");
  });

  it("ignores everything after --", () => {
    expect(readFormat(["lock", "run", "x", "--", "cmd", "--format", "json"])).toBe("auto");
  });

  it("rejects an unknown value or a missing one", () => {
    expect(() => readFormat(["--format", "yaml"])).toThrow(UsageError);
    expect(() => readFormat(["--format"])).toThrow(/expects a value/);
  });
});
