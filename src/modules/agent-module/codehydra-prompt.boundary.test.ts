// @vitest-environment node
/**
 * Boundary tests for the composed CodeHydra system prompts
 * (dist/bin/codehydra-prompt-{claude,opencode}.md).
 *
 * The files are composed by `pnpm build:wrappers` from resources/prompts
 * (shared + a per-agent appendix) and passed to the agents by absolute path,
 * so the assertions target the built artifacts rather than the sources — that
 * is what actually ships, and it catches a composition that silently dropped a
 * part. Same dependency as the wrapper boundary tests, which read the compiled
 * scripts from the same directory.
 *
 * Asserting the load-bearing facts rather than the prose: rewording is free,
 * dropping a rule is not.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve, join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

const DIST_BIN = resolve(__dirname, "../../../dist/bin");
const CLAUDE_PROMPT = join(DIST_BIN, "codehydra-prompt-claude.md");
const OPENCODE_PROMPT = join(DIST_BIN, "codehydra-prompt-opencode.md");

/** Budget agreed per agent file: additions have to displace something. */
const MAX_WORDS = 300;

const countWords = (text: string): number => text.trim().split(/\s+/).length;

describe("composed agent system prompts", () => {
  let claude: string;
  let opencode: string;

  beforeAll(async () => {
    for (const file of [CLAUDE_PROMPT, OPENCODE_PROMPT]) {
      await expect(
        access(file, constants.R_OK),
        `${file} missing — run \`pnpm build:wrappers\` to compose the prompts`
      ).resolves.toBeUndefined();
    }
    claude = await readFile(CLAUDE_PROMPT, "utf-8");
    opencode = await readFile(OPENCODE_PROMPT, "utf-8");
  });

  describe.each([
    ["claude", () => claude],
    ["opencode", () => opencode],
  ])("%s", (_agent, get) => {
    it("defines what busy and idle mean", () => {
      expect(get()).toContain("busy");
      expect(get()).toContain("idle");
      expect(get()).toContain("without further user input");
    });

    it("keeps workspace creation the user's call", () => {
      expect(get()).toContain("the user's call");
    });

    it("stays within the word budget", () => {
      expect(countWords(get())).toBeLessThanOrEqual(MAX_WORDS);
    });
  });

  it("tells Claude how to opt a background shell out of keeping the workspace busy", () => {
    expect(claude).toContain("ch-bg");
  });

  it("does not tell OpenCode about ch-bg", () => {
    // Only detectable in Claude's background_tasks, and not on OpenCode's PATH.
    expect(opencode).not.toContain("ch-bg");
  });

  it("gives OpenCode the whole shared prompt, and Claude that plus its appendix", () => {
    expect(claude.startsWith(opencode.trimEnd())).toBe(true);
    expect(countWords(claude)).toBeGreaterThan(countWords(opencode));
  });
});
