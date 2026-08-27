// @vitest-environment node
/**
 * Integration tests for the operation registry.
 *
 * The registry knows nothing about any adapter, so these cover only what it is
 * responsible for: input shaping handed in by a caller, `requiresWorkspace`
 * enforcement, and the error categories adapters translate into their own
 * failure vocabulary.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { OperationRegistry } from "./registry";
import { ApiError } from "./errors";
import { defineEntry } from "./types";
import type { AnyOperationEntry, OperationContext } from "./types";
import { workspacePathSchema } from "../intents/contract";

const WS = workspacePathSchema.parse("/repo/wt/feature");
const IN_WORKSPACE: OperationContext = { workspacePath: WS, cwd: null };
const NO_WORKSPACE: OperationContext = { workspacePath: null, cwd: null };

/** A delete-shaped entry, so shaping is exercised on the real divergence. */
function deleteEntry(calls: unknown[]): AnyOperationEntry {
  return defineEntry({
    name: "workspace.delete",
    kind: "command",
    description: "Delete a workspace.",
    input: z.object({
      keepBranch: z.boolean().default(false),
      ignoreWarnings: z.boolean().default(false),
    }),
    requiresWorkspace: true,
    handler: async (_ctx, input) => {
      calls.push(input);
      return { started: true };
    },
  });
}

function globalEntry(): AnyOperationEntry {
  return defineEntry({
    name: "project.list",
    kind: "command",
    description: "List projects.",
    input: z.object({}),
    requiresWorkspace: false,
    handler: async () => [],
  });
}

function strictEntry(): AnyOperationEntry {
  return defineEntry({
    name: "agent.status.set",
    kind: "command",
    description: "Nudge agent status.",
    input: z.object({ status: z.enum(["idle", "busy"]) }),
    requiresWorkspace: true,
    handler: async () => null,
  });
}

describe("OperationRegistry", () => {
  describe("input shaping", () => {
    it("fills a field the caller omitted from the adapter's defaults", async () => {
      const calls: unknown[] = [];
      const entry = deleteEntry(calls);
      const registry = new OperationRegistry([entry]);

      await registry.invoke(entry, IN_WORKSPACE, {}, { defaults: { keepBranch: true } });

      expect(calls[0]).toMatchObject({ keepBranch: true });
    });

    it("lets an explicit caller value win over the adapter default", async () => {
      const calls: unknown[] = [];
      const entry = deleteEntry(calls);
      const registry = new OperationRegistry([entry]);

      await registry.invoke(
        entry,
        IN_WORKSPACE,
        { keepBranch: false },
        { defaults: { keepBranch: true } }
      );

      expect(calls[0]).toMatchObject({ keepBranch: false });
    });

    it("falls back to the schema default when no shaping is given", async () => {
      const calls: unknown[] = [];
      const entry = deleteEntry(calls);
      const registry = new OperationRegistry([entry]);

      await registry.invoke(entry, IN_WORKSPACE, {});

      expect(calls[0]).toMatchObject({ keepBranch: false });
    });

    it("drops fields outside the adapter's pick", async () => {
      const calls: unknown[] = [];
      const entry = deleteEntry(calls);
      const registry = new OperationRegistry([entry]);

      await registry.invoke(
        entry,
        IN_WORKSPACE,
        { keepBranch: true, ignoreWarnings: true },
        { pick: ["keepBranch"] }
      );

      // ignoreWarnings reverts to the schema default rather than the caller's value.
      expect(calls[0]).toMatchObject({ keepBranch: true, ignoreWarnings: false });
    });
  });

  describe("requiresWorkspace", () => {
    it("rejects with no-workspace before validating input", async () => {
      const entry = strictEntry();
      const registry = new OperationRegistry([entry]);

      // The input is invalid too; the workspace failure must win so the CLI
      // reports "not in a workspace" rather than a confusing usage error.
      const error = await registry
        .invoke(entry, NO_WORKSPACE, { status: "nonsense" })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).category).toBe("no-workspace");
    });

    it("allows an app-global entry with no workspace", async () => {
      const entry = globalEntry();
      const registry = new OperationRegistry([entry]);

      await expect(registry.invoke(entry, NO_WORKSPACE, {})).resolves.toEqual([]);
    });
  });

  describe("validation", () => {
    it("categorizes invalid input as a usage error naming the operation", async () => {
      const entry = strictEntry();
      const registry = new OperationRegistry([entry]);

      const error = await registry
        .invoke(entry, IN_WORKSPACE, { status: "nonsense" })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).category).toBe("usage");
      expect((error as ApiError).message).toContain("agent.status.set");
    });
  });

  describe("lookup", () => {
    it("returns an entry by name", () => {
      const entry = globalEntry();
      expect(new OperationRegistry([entry]).get("project.list")).toBe(entry);
    });

    it("throws for an operation the registry was built without", () => {
      const registry = new OperationRegistry([globalEntry()]);
      expect(() => registry.get("workspace.delete")).toThrow(/No registry entry/);
    });

    it("rejects duplicate entry names", () => {
      expect(() => new OperationRegistry([globalEntry(), globalEntry()])).toThrow(/Duplicate/);
    });
  });
});
