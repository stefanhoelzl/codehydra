import { describe, it, expect } from "vitest";
import { CommandLineError, splitCommandLine } from "./command-line";

describe("splitCommandLine", () => {
  it("splits on whitespace", () => {
    expect(splitCommandLine("  op run   --env-file .env.tpl -- ")).toEqual([
      "op",
      "run",
      "--env-file",
      ".env.tpl",
      "--",
    ]);
  });

  it("groups quoted text and removes the quotes", () => {
    expect(splitCommandLine(`a "b c" 'd e' f"g h"i`)).toEqual(["a", "b c", "d e", "fg hi"]);
  });

  it("keeps backslashes literal except for escaped quotes in double quotes", () => {
    expect(splitCommandLine(String.raw`C:\tools\op.exe "say \"hi\"" "a\\b" "c\d"`)).toEqual([
      String.raw`C:\tools\op.exe`,
      `say "hi"`,
      String.raw`a\b`,
      String.raw`c\d`,
    ]);
  });

  it("keeps an empty quoted argument", () => {
    expect(splitCommandLine(`a "" b`)).toEqual(["a", "", "b"]);
  });

  it("expands variables without splitting their values", () => {
    expect(
      splitCommandLine("uvx heyl --project heyl://${SERVER}/${PROJECT} ${MISSING}x", {
        SERVER: "github.com",
        PROJECT: "org/my repo",
      })
    ).toEqual(["uvx", "heyl", "--project", "heyl://github.com/org/my repo", "x"]);
  });

  it("returns no arguments for a blank line", () => {
    expect(splitCommandLine("   ")).toEqual([]);
  });

  it("rejects an unclosed quote", () => {
    expect(() => splitCommandLine(`op "run`)).toThrow(CommandLineError);
  });
});
