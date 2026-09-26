/**
 * What an automation's script prints: a JSON array of items, each one action.
 *
 * `action` is the discriminator. Every action an automation may run
 * (`plugin-actions-map.ts`) contributes one branch whose fields are that
 * operation's own input — the same fields `ch` and MCP take — so a script
 * author learns one vocabulary, and `ch <command> --help` documents it.
 *
 * `workspace.create` adds three fields only automations have:
 *
 * - `event` (default `false`): `false` states that the workspace should exist —
 *   it is remembered by `key`, so printing the same list every poll is safe;
 *   `true` reports that something happened, and fires every time it is printed.
 * - `key` (default: `name`): the identity a `false` item is remembered by.
 * - `metadata`: `title`, `tags` (by name: `color`, `label`, `description`) and
 *   any other key, applied to the workspace it creates or matches.
 *
 * Items are strict, unlike the registry's own schemas: a caller of `ch` or MCP
 * is generated from the schema, but a script is written by hand, and a typo'd
 * field that silently did nothing is the worst failure it could have. The
 * schemas are built from the registry at run time, so they are the ones the
 * operations validate with.
 */

import { z } from "zod/v4";
import type { OperationRegistry } from "../../api/registry";
import type { OperationName } from "../../api/names";
import { PLUGIN_ACTION_NAMES } from "../../api/adapters/plugin-actions-map";
import { isValidMetadataKey, TAGS_METADATA_KEY_PREFIX } from "../../shared/api/types";

/** The action that creates workspaces, with the automation-only fields. */
export const CREATE_ACTION = "workspace.create";

const tagSchema = z
  .object({
    color: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const metadataSchema = z
  .object({
    title: z.string().optional().describe("Sidebar title"),
    tags: z
      .record(
        z.string().refine((name) => isValidMetadataKey(`${TAGS_METADATA_KEY_PREFIX}${name}`), {
          error: "not a valid tag name",
        }),
        tagSchema
      )
      .optional()
      .describe("Tags by name: { color, label, description }"),
  })
  .catchall(z.string())
  .superRefine((metadata, ctx) => {
    for (const key of Object.keys(metadata)) {
      if (key === "title" || key === "tags") continue;
      if (!isValidMetadataKey(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "not a valid metadata key" });
      }
    }
  });

const createExtras = {
  event: z
    .boolean()
    .default(false)
    .describe(
      "false (default): this workspace should exist — remembered by key, never recreated " +
        "while listed. true: something happened — fires every time it is printed."
    ),
  key: z
    .string()
    .min(1)
    .optional()
    .describe("Identity of an event: false item across polls (default: name)"),
  metadata: metadataSchema.optional(),
};

export type ItemMetadata = z.infer<typeof metadataSchema>;

/** One validated item: its action, and that action's input. */
export interface AutomationItem {
  readonly action: OperationName;
  readonly input: Record<string, unknown>;
}

/** A create item, as the automations engine reads it. */
export interface CreateItem {
  readonly name: string;
  readonly project?: string;
  readonly base?: string;
  readonly tracking?: string;
  readonly prompt?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly agentName?: string;
  readonly stealFocus: boolean;
  readonly event: boolean;
  readonly key?: string;
  readonly metadata?: ItemMetadata;
}

export interface ItemSchemas {
  /** Validate one printed item. Throws a message naming the action and field. */
  parse(raw: unknown): AutomationItem;
  /** The item array's JSON Schema, for `ch plugin schema --items`. */
  jsonSchema(): Record<string, unknown>;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  if (issue.code === "unrecognized_keys") {
    return `${at}unknown ${issue.keys.length === 1 ? "field" : "fields"} ${issue.keys.join(", ")}`;
  }
  if (issue.code === "invalid_key") {
    return `${at}${issue.issues.map((keyIssue) => keyIssue.message).join("; ")}`;
  }
  return `${at}${issue.message}`;
}

export function createItemSchemas(registry: OperationRegistry): ItemSchemas {
  // An action the registry lacks has no schema to extend; it is simply not an
  // item (a registry built for a test holds only what the test needs).
  const actions = PLUGIN_ACTION_NAMES.filter((name) => registry.find(name) !== undefined);
  const branches = actions.map((name) => {
    const input = registry.get(name).input;
    if (!(input instanceof z.ZodObject)) {
      throw new Error(`The input of ${name} is not an object, so it cannot be an item`);
    }
    const withAction = input.extend({ action: z.literal(name) });
    return (name === CREATE_ACTION ? withAction.extend(createExtras) : withAction).strict();
  });
  const union = z.discriminatedUnion(
    "action",
    branches as unknown as [z.ZodObject, ...z.ZodObject[]]
  );

  return {
    parse(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("an item must be a JSON object");
      }
      const action = (raw as { action?: unknown }).action;
      if (typeof action !== "string") throw new Error("an item needs an action");
      if (!(actions as readonly string[]).includes(action)) {
        throw new Error(`${action} is not an action an automation can run`);
      }
      const parsed = union.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`${action}: ${describeIssue(parsed.error.issues[0]!)}`);
      }
      const input: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) };
      delete input["action"];
      return { action: action as OperationName, input };
    },
    jsonSchema() {
      return {
        title: "What a CodeHydra automation's script prints",
        ...z.toJSONSchema(z.array(union), { unrepresentable: "any", io: "input" }),
      };
    },
  };
}
