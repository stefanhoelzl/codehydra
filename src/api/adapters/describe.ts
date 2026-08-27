/**
 * Serializing the registry for out-of-process clients.
 *
 * `ch` runs in its own process, so it cannot import handlers that close over the
 * dispatcher. It asks the running app what exists instead — which is what makes
 * `ch --help` and `ch mcp`'s tool list come from the same registry as everything
 * else, with no generated file to fall out of date.
 *
 * This lives in the adapter layer, not in an entry: describing "the MCP view" or
 * "the CLI view" needs to know those adapters exist, and the registry must not.
 */

import { z } from "zod/v4";
import type { OperationRegistry } from "../registry";
import type { OperationName } from "../names";
import { MCP_MAP } from "./mcp-map";
import { CLI_MAP } from "./cli-map";

/** Channel the plugin wire answers describe requests on. */
export const DESCRIBE_CHANNEL = "api:registry:describe";

export type DescribeTarget = "mcp" | "cli";

/** One operation, as an out-of-process client needs to see it. */
export interface OperationDescriptor {
  readonly name: OperationName;
  readonly kind: "command" | "event";
  readonly description: string;
  readonly instructions?: string;
  /** JSON Schema for the input, already narrowed to this adapter's shaping. */
  readonly inputSchema: unknown;
  /** MCP tool name, when describing the MCP view. */
  readonly tool?: string;
  /** Subcommand path, when describing the CLI view. */
  readonly path?: readonly string[];
  /** Positional argument order, when describing the CLI view. */
  readonly positionals?: readonly string[];
}

/**
 * Describe one adapter's view of the registry.
 *
 * Schemas are converted with `io: "input"`, so a field carrying a default shows
 * as optional — which is what a caller filling in arguments needs to know, and
 * what an MCP client expects of a tool's inputSchema.
 */
export function describe(
  registry: OperationRegistry,
  target: DescribeTarget
): readonly OperationDescriptor[] {
  const descriptors: OperationDescriptor[] = [];

  for (const [name, mapping] of Object.entries(target === "mcp" ? MCP_MAP : CLI_MAP)) {
    if (mapping === null) continue;
    // Skip rather than throw for the same reason the adapter does: an operation
    // a mapping names but the registry lacks should cost that one entry, not the
    // whole description. Completeness is asserted by the conformance tests.
    const entry = registry.find(name as OperationName);
    if (entry === undefined) continue;

    const schema = z.toJSONSchema(entry.input as z.ZodType, { io: "input" });
    descriptors.push({
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      ...(entry.instructions !== undefined && { instructions: entry.instructions }),
      inputSchema: narrow(schema, mapping.pick),
      ...("tool" in mapping && { tool: mapping.tool }),
      ...("path" in mapping && { path: mapping.path }),
      ...("positionals" in mapping &&
        mapping.positionals !== undefined && { positionals: mapping.positionals }),
    });
  }

  return descriptors;
}

/**
 * Drop properties the adapter does not accept from a JSON Schema object.
 *
 * Without this a client would offer arguments the adapter silently discards —
 * the plugin wire's workspace-scoped channels, for instance, take no target.
 */
function narrow(schema: unknown, pick: readonly string[] | undefined): unknown {
  if (pick === undefined || schema === null || typeof schema !== "object") return schema;
  const object = schema as { properties?: Record<string, unknown>; required?: string[] };
  if (!object.properties) return schema;

  return {
    ...object,
    properties: Object.fromEntries(
      Object.entries(object.properties).filter(([key]) => pick.includes(key))
    ),
    ...(object.required && { required: object.required.filter((key) => pick.includes(key)) }),
  };
}
