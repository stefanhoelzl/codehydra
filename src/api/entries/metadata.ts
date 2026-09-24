/**
 * Metadata registry entries, plus the title and tag commands composed on top.
 *
 * Title and tags are stored as ordinary metadata — `title`, and the `tags.`
 * prefix — so they need no storage of their own. They exist as entries because
 * hand-writing the key convention is the error-prone part: the MCP tool
 * description for set_metadata currently spends five lines explaining it.
 */

import { z } from "zod/v4";
import { ApiError } from "../errors";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import type { EntryDeps } from "./deps";
import { createTargetResolver, targetFields } from "./target";
import type { WorkspacePath } from "../../intents/contract";
import { extractTags, isValidMetadataKey } from "../../shared/api/types";

import { INTENT_GET_METADATA } from "../../intents/get-metadata";
import type { GetMetadataIntent } from "../../intents/get-metadata";
import { INTENT_SET_METADATA } from "../../intents/set-metadata";
import type { SetMetadataIntent } from "../../intents/set-metadata";

const TAG_PREFIX = "tags.";

export function metadataEntries(deps: EntryDeps): readonly AnyOperationEntry[] {
  const { dispatcher } = deps;
  const targetOf = createTargetResolver(dispatcher);

  const read = (workspacePath: WorkspacePath) =>
    dispatcher.dispatch<GetMetadataIntent>({
      type: INTENT_GET_METADATA,
      payload: { workspacePath },
    });

  const write = async (workspacePath: WorkspacePath, key: string, value: string | null) => {
    if (!isValidMetadataKey(key)) {
      throw new ApiError(
        "usage",
        `Invalid metadata key "${key}": dot-separated segments, each starting with a letter ` +
          `and containing only letters, digits and hyphens.`
      );
    }
    await dispatcher.dispatch<SetMetadataIntent>({
      type: INTENT_SET_METADATA,
      payload: { workspacePath, key, value },
    });
    return null;
  };

  const get = defineEntry({
    name: "metadata.get",
    kind: "command",
    description: "Get all metadata for a workspace.",
    instructions: "Always includes a 'base' key holding the base branch name.",
    input: z.object(targetFields),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const result = await read(await targetOf(ctx, input));
      if (!result) throw new Error("Get metadata returned no result");
      return result;
    },
  });

  const set = defineEntry({
    name: "metadata.set",
    kind: "command",
    description: "Set or delete a metadata key on a workspace.",
    instructions:
      "Pass a null value to delete the key. Prefer the dedicated title and tag commands over " +
      "writing the 'title' key or 'tags.' prefix by hand.",
    input: z.object({
      ...targetFields,
      key: z.string().describe("Metadata key, e.g. 'base' or 'tags.bugfix'"),
      value: z.string().nullable().describe("Value to set, or null to delete the key"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => write(await targetOf(ctx, input), input.key, input.value),
  });

  const title = defineEntry({
    name: "workspace.title",
    kind: "command",
    description: "Set or clear the workspace's sidebar display title.",
    instructions:
      "Clearing reverts the sidebar row to the branch name. This changes a label only — it " +
      "does NOT delete the workspace.",
    input: z.object({
      ...targetFields,
      title: z
        .string()
        .nullable()
        .describe("Title to display, or null to clear it and show the branch name"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      // A blank title reads as absent (readTitle trims), so normalize it to a
      // delete rather than storing whitespace that renders as an empty row.
      const value = input.title === null || input.title.trim() === "" ? null : input.title;
      return write(await targetOf(ctx, input), "title", value);
    },
  });

  const tagList = defineEntry({
    name: "workspace.tag.list",
    kind: "command",
    description: "List a workspace's tags.",
    input: z.object(targetFields),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      const metadata = await read(await targetOf(ctx, input));
      return extractTags(metadata ?? {});
    },
  });

  const tagSet = defineEntry({
    name: "workspace.tag.set",
    kind: "command",
    description: "Add or update a tag on a workspace.",
    instructions:
      "Replaces the tag entirely — any field you omit is cleared, so re-pass the ones you " +
      "want to keep.",
    input: z.object({
      ...targetFields,
      name: z.string().min(1).describe("Tag name"),
      color: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Hex color, e.g. '#8b949e'. Without one the tag renders as bare text, not a pill"
        ),
      label: z
        .string()
        .optional()
        .describe("Shown instead of the tag name — any UTF-8, e.g. an emoji. Trimmed"),
      description: z
        .string()
        .optional()
        .describe("Hover text, shown instead of the tag name in the tooltip. Trimmed"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) => {
      // Full replace: what is stored is exactly what this call passed. No
      // read-before-write, so a tag is always exactly what its last setter said.
      const tag: { color?: string; label?: string; description?: string } = {};
      if (input.color !== undefined) tag.color = input.color;
      if (input.label !== undefined) tag.label = input.label.trim();
      if (input.description !== undefined) tag.description = input.description.trim();
      return write(await targetOf(ctx, input), `${TAG_PREFIX}${input.name}`, JSON.stringify(tag));
    },
  });

  const tagRemove = defineEntry({
    name: "workspace.tag.remove",
    kind: "command",
    description: "Remove a tag from a workspace.",
    input: z.object({
      ...targetFields,
      name: z.string().min(1).describe("Tag name"),
    }),
    requiresWorkspace: true,
    handler: async (ctx, input) =>
      write(await targetOf(ctx, input), `${TAG_PREFIX}${input.name}`, null),
  });

  return [get, set, title, tagList, tagSet, tagRemove];
}
