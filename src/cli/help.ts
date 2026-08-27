/**
 * Rendering `ch --help`.
 *
 * The command list comes from the running app's registry rather than from a
 * table compiled into the binary, so help can never describe operations the app
 * does not have, or omit ones it gained.
 */

import type { OperationDescriptor } from "../api/adapters/describe";

/** Group descriptors by their first path segment: `ws`, `project`, and the rest. */
function group(
  descriptors: readonly OperationDescriptor[]
): ReadonlyMap<string, readonly OperationDescriptor[]> {
  const groups = new Map<string, OperationDescriptor[]>();
  for (const descriptor of descriptors) {
    const [head = ""] = descriptor.path ?? [];
    const bucket = groups.get(head) ?? [];
    bucket.push(descriptor);
    groups.set(head, bucket);
  }
  return groups;
}

const BUILTIN = [
  ["mcp", "Run as an MCP server over stdio (used by agent configs)"],
  ["bg <cmd…>", "Run a command without keeping the workspace busy"],
  ["claude [args…]", "Launch the Claude agent"],
  ["opencode [args…]", "Launch the OpenCode agent"],
] as const;

/** Two aligned columns of `command  summary`. */
function columns(rows: readonly (readonly [string, string])[], indent = "  "): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`).join("\n");
}

export function renderHelp(descriptors: readonly OperationDescriptor[]): string {
  const sections: string[] = [
    "ch — drive CodeHydra from a shell",
    "",
    "Usage: ch <command> [arguments] [flags]",
    "",
  ];

  for (const [head, items] of group(descriptors)) {
    sections.push(`${head}:`);
    sections.push(
      columns(
        [...items]
          .sort((a, b) => (a.path ?? []).join(" ").localeCompare((b.path ?? []).join(" ")))
          .map((d) => [(d.path ?? []).join(" "), d.description] as const)
      )
    );
    sections.push("");
  }

  sections.push("built in:");
  sections.push(columns(BUILTIN.map(([left, right]) => [left, right] as const)));
  sections.push("");
  sections.push("global flags:");
  sections.push(
    columns([
      ["--workspace <path>", "Act on this workspace instead of the one containing cwd"],
      ["--input <json>", "Supply the whole payload as JSON"],
      ["--json / --no-json", "Force JSON or human output (default: JSON when piped)"],
      ["--data-dir <path>", "Target a different CodeHydra instance"],
      ["--help", "Show this, or a command's own arguments"],
    ])
  );

  return sections.join("\n");
}

/** Help for one command: its summary, long-form guidance, and arguments. */
export function renderCommandHelp(descriptor: OperationDescriptor): string {
  const path = (descriptor.path ?? []).join(" ");
  const schema = descriptor.inputSchema as {
    properties?: Record<string, { type?: string | string[]; description?: string }>;
    required?: string[];
  };

  const sections = [`ch ${path} — ${descriptor.description}`, ""];
  if (descriptor.instructions) sections.push(descriptor.instructions, "");

  if (descriptor.positionals?.length) {
    sections.push(`Usage: ch ${path} ${descriptor.positionals.map((p) => `<${p}>`).join(" ")}`, "");
  }

  const properties = Object.entries(schema.properties ?? {});
  if (properties.length > 0) {
    sections.push("arguments:");
    sections.push(
      columns(
        properties.map(([name, spec]) => {
          const type = Array.isArray(spec.type) ? spec.type.join("|") : (spec.type ?? "value");
          const required = schema.required?.includes(name) ? " (required)" : "";
          return [
            `--${toKebabCase(name)} <${type}>`,
            `${spec.description ?? ""}${required}`.trim(),
          ];
        })
      )
    );
  }

  return sections.join("\n");
}

/** `keepBranch` is spelled `--keep-branch` on the command line. */
function toKebabCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
