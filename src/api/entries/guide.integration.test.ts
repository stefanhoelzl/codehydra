// @vitest-environment node
/**
 * Integration tests for the guide entry: whole guide, one section by slug, and
 * the failure that tells a caller which slugs exist.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { ApiError } from "../errors";
import type { OperationRegistry } from "../registry";
import { createRegistry } from "./index";
import { createLockModule } from "../../modules/lock-module";

const GUIDE = [
  "# User Guide",
  "",
  "Intro.",
  "",
  "## Getting started",
  "",
  "Install it.",
  "",
  "## Repository hooks",
  "",
  "```bash",
  "## not a heading",
  "```",
  "",
  "### after-worktree-created",
  "",
  "Runs once.",
  "",
].join("\n");

function registry(): OperationRegistry {
  return createRegistry(
    {
      dispatcher: createMockDispatcher(),
      appLayer: { openPath: async () => undefined },
      awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
      locks: createLockModule({ dispatcher: createMockDispatcher(), logger: SILENT_LOGGER }).locks,
      config: createMockConfig(),
      readUserGuide: async () => GUIDE,
    },
    SILENT_LOGGER
  );
}

function call(input: Record<string, unknown>): Promise<unknown> {
  const reg = registry();
  return reg.invoke(
    reg.get("guide"),
    {
      workspacePath: null,
      callerWorkspacePath: null,
      cwd: null,
      signal: new AbortController().signal,
    },
    input
  );
}

describe("guide entry", () => {
  it("returns the whole guide without a section", async () => {
    expect(await call({})).toBe(GUIDE);
  });

  it("returns one section by slug, up to the next ## heading", async () => {
    expect(await call({ section: "getting-started" })).toBe("## Getting started\n\nInstall it.\n");
  });

  it("keeps subsections and fenced code in the section", async () => {
    const section = (await call({ section: "repository-hooks" })) as string;
    expect(section).toContain("## not a heading");
    expect(section).toContain("### after-worktree-created");
    expect(section).toContain("Runs once.");
  });

  it("fails not-found on an unknown slug, listing the valid ones", async () => {
    const error = await call({ section: "nope" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).category).toBe("not-found");
    expect((error as ApiError).message).toContain("getting-started, repository-hooks");
  });
});
