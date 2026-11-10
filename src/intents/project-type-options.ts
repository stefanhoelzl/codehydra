/**
 * What each project type lets a caller choose when a workspace is created or
 * deleted, and the one place those choices are merged and checked.
 *
 * A project type describes its options declaratively (`ProjectTypeDescription`)
 * by answering app:start's `register-project-types` hook point. One description
 * drives three things:
 *
 * - the create / delete dialog fields (creation-module, deletion-dialog-module),
 * - the `workspace.create` / `workspace.delete` input schema, and through it the
 *   `ch` flags, the MCP params, the sidekick API and automation items,
 * - the check that a call only passes options its project's type declares.
 *
 * The fields of every type are merged top level into the operation input, so
 * git's `base` is `--base` and not `--git-base`. Two types may declare the same
 * name only with the same definition; anything else fails startup.
 *
 * Core never interprets an option: it checks a value against the owning type's
 * declaration, applies that type's defaults, and hands the record to the type's
 * own handlers as `options`.
 */

import { z } from "zod/v4";
import { ApiError } from "../api/errors";
import { parseProjectRef } from "../utils/ref";

// =============================================================================
// The description a project type answers with
// =============================================================================

/** One choice of a select with static choices. */
export const optionChoiceSchema = z
  .object({
    value: z.string().min(1),
    /** Shown in the dialog; the value when absent. */
    label: z.string().optional(),
  })
  .readonly();
export type OptionChoice = z.infer<typeof optionChoiceSchema>;

/**
 * One option.
 *
 * - `text`: a free string. A non-empty string on every surface.
 * - `checkbox`: a boolean.
 * - `select`: one of `choices`. Static choices are an enum everywhere;
 *   `"dynamic"` choices come from the type at run time
 *   (`project:get-option-choices`) and are a plain string on the CLI and MCP —
 *   the type's own handler checks the value.
 */
export const optionFieldSchema = z
  .object({
    kind: z.enum(["text", "checkbox", "select"]),
    /** Dialog label. The field name when absent. */
    label: z.string().optional(),
    /** One line for `--help`, MCP and the plugin schema. */
    description: z.string().optional(),
    /** Applied after routing, for a project of the declaring type only. */
    default: z.union([z.string(), z.boolean()]).optional(),
    choices: z.union([z.literal("dynamic"), z.array(optionChoiceSchema).readonly()]).optional(),
    /** Placeholder for a text or select field in the dialog. */
    placeholder: z.string().optional(),
    /** The CLI takes it as the positional argument after the core ones. */
    positional: z.boolean().optional(),
    /** `false`: on every surface but the dialog. */
    dialog: z.boolean().optional(),
  })
  .readonly()
  .superRefine((field, ctx) => {
    if ((field.kind === "select") !== (field.choices !== undefined)) {
      ctx.addIssue({ code: "custom", message: "choices belong to a select, and only to one" });
    }
    if (field.default !== undefined && typeof field.default !== defaultTypeOf(field.kind)) {
      ctx.addIssue({
        code: "custom",
        message: `a ${field.kind}'s default must be a ${defaultTypeOf(field.kind)}`,
      });
    }
    if (field.positional === true && field.kind === "checkbox") {
      ctx.addIssue({ code: "custom", message: "a checkbox cannot be positional" });
    }
  });
export type OptionField = z.infer<typeof optionFieldSchema>;

function defaultTypeOf(kind: OptionField["kind"]): "string" | "boolean" {
  return kind === "checkbox" ? "boolean" : "string";
}

/**
 * Option names are camelCase: they are input fields, the CLI spells them as
 * kebab-case flags (`keepBranch` → `--keep-branch`), and a plugin hook reads
 * them by name.
 */
const optionNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "must be camelCase");

const optionFieldsSchema = z.record(optionNameSchema, optionFieldSchema);

/** What one project type answers `register-project-types` with. */
export const projectTypeDescriptionSchema = z
  .object({
    /** The project type, as in its refs (`ch::<machine>::<type>::…`). */
    type: z.string().min(1),
    /** Options of `workspace.create`. */
    create: optionFieldsSchema.optional(),
    /** Options of `workspace.delete`. */
    delete: optionFieldsSchema.optional(),
    /**
     * What this type's delete preflight objects to, as one phrase — completes
     * "Fails if the project's type objects to the delete (for <type>: …)".
     */
    deleteObjections: z.string().optional(),
  })
  .readonly();
export type ProjectTypeDescription = z.infer<typeof projectTypeDescriptionSchema>;

/** The two operations a type declares options for. */
export type OptionStage = "create" | "delete";

/** Option values as a type's handlers receive them: checked, defaults applied. */
export type OptionValues = Readonly<Record<string, string | boolean>>;

// =============================================================================
// Merging and checking
// =============================================================================

/** The zod schema one option's value is checked with. */
function valueSchema(field: OptionField): z.ZodType<string | boolean> {
  switch (field.kind) {
    case "checkbox":
      return z.boolean();
    case "text":
      return z.string().min(1);
    case "select":
      if (field.choices === "dynamic" || field.choices === undefined) return z.string().min(1);
      return z.enum(field.choices.map((choice) => choice.value) as [string, ...string[]]);
  }
}

/** Whether two types' declarations of one name are the same option. */
function sameField(a: OptionField, b: OptionField): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(field: OptionField): unknown {
  return Object.fromEntries(
    Object.entries(field)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

interface Merged {
  readonly descriptions: readonly ProjectTypeDescription[];
  /** Per stage: every option name, its definition, and the types declaring it. */
  readonly fields: Readonly<
    Record<OptionStage, ReadonlyMap<string, { field: OptionField; types: readonly string[] }>>
  >;
}

/**
 * Merge the descriptions every type answered with.
 *
 * Throws, naming the types, when the result could not be one input schema:
 * a type answering twice, an option named like a core field of the operation,
 * one name declared with two definitions, or more than one positional option
 * (the CLI parses arguments before it knows which type the project is).
 */
export function mergeTypeFields(
  answers: readonly ProjectTypeDescription[],
  reserved: Readonly<Record<OptionStage, ReadonlySet<string>>>
): Merged {
  const descriptions = answers.map((answer) => projectTypeDescriptionSchema.parse(answer));
  const seen = new Set<string>();
  for (const description of descriptions) {
    if (seen.has(description.type)) {
      throw new Error(`Project type "${description.type}" described its options twice`);
    }
    seen.add(description.type);
  }

  const mergeStage = (stage: OptionStage) => {
    const fields = new Map<string, { field: OptionField; types: string[] }>();
    for (const description of descriptions) {
      for (const [name, field] of Object.entries(description[stage] ?? {})) {
        if (reserved[stage].has(name)) {
          throw new Error(
            `Project type "${description.type}" declares the ${stage} option "${name}", ` +
              `which is a field of every workspace ${stage}`
          );
        }
        const known = fields.get(name);
        if (known === undefined) {
          fields.set(name, { field, types: [description.type] });
        } else if (!sameField(known.field, field)) {
          throw new Error(
            `Project types "${known.types[0]}" and "${description.type}" both declare the ` +
              `${stage} option "${name}", differently`
          );
        } else {
          known.types.push(description.type);
        }
      }
    }
    const positional = [...fields.entries()].filter(([, { field }]) => field.positional === true);
    if (positional.length > 1) {
      throw new Error(
        `More than one positional ${stage} option: ` +
          positional.map(([name, { types }]) => `"${name}" (${types.join(", ")})`).join(", ")
      );
    }
    return fields;
  };

  return { descriptions, fields: { create: mergeStage("create"), delete: mergeStage("delete") } };
}

/**
 * Every project type's options, once app:start has collected them.
 *
 * Built empty at composition, sealed once by app:start before anything is
 * served. Reading it before then is a wiring bug and throws, as a registry
 * lookup of a missing entry does.
 */
export class ProjectTypeOptions {
  private merged: Merged | undefined;
  private readonly reserved: Record<OptionStage, Set<string>> = {
    create: new Set(),
    delete: new Set(),
  };

  /**
   * Claim core field names a type must not declare. The registry does this as
   * it is built, before app:start seals; on a holder sealed already (a test's)
   * the claim is checked against what was merged instead.
   */
  reserve(stage: OptionStage, names: Iterable<string>): void {
    for (const name of names) {
      this.reserved[stage].add(name);
      const clash = this.merged?.fields[stage].get(name);
      if (clash !== undefined) {
        throw new Error(
          `Project type "${clash.types[0]}" declares the ${stage} option "${name}", ` +
            `which is a field of every workspace ${stage}`
        );
      }
    }
  }

  /** Merge the types' descriptions. Throws on a clash (see `mergeTypeFields`). */
  seal(descriptions: readonly ProjectTypeDescription[]): void {
    if (this.merged !== undefined) throw new Error("Project type options are already sealed");
    this.merged = mergeTypeFields(descriptions, this.reserved);
  }

  isSealed(): boolean {
    return this.merged !== undefined;
  }

  private get state(): Merged {
    if (this.merged === undefined) {
      throw new Error("Project type options read before app:start collected them");
    }
    return this.merged;
  }

  /** The description a type answered with; undefined for a type that declares nothing. */
  of(type: string): ProjectTypeDescription | undefined {
    return this.state.descriptions.find((description) => description.type === type);
  }

  /** Every description, in the order the types answered. */
  descriptions(): readonly ProjectTypeDescription[] {
    return this.state.descriptions;
  }

  /** The type of a project, from its ref. */
  typeOf(projectRef: string): string {
    const parts = parseProjectRef(projectRef);
    if (parts === null) throw new Error(`Not a project ref: ${projectRef}`);
    return parts.type;
  }

  /** A type's own options for one stage, by name. */
  fieldsOf(type: string, stage: OptionStage): Readonly<Record<string, OptionField>> {
    return this.of(type)?.[stage] ?? {};
  }

  /** Every option name of a stage, across all types. */
  names(stage: OptionStage): readonly string[] {
    return [...this.state.fields[stage].keys()];
  }

  /** The positional option of a stage, if a type declares one. */
  positional(stage: OptionStage): string | undefined {
    for (const [name, { field }] of this.state.fields[stage]) {
      if (field.positional === true) return name;
    }
    return undefined;
  }

  /**
   * The merged options as zod fields, for an operation's input.
   *
   * Every one is optional with no zod default: a default filled in for every
   * call would hand git's `keepBranch` to a project that is not git. The
   * declared default is carried as JSON Schema annotation only, so a client
   * still learns it, and is applied after routing (`resolve`).
   */
  inputShape(stage: OptionStage): Record<string, z.ZodType> {
    const shape: Record<string, z.ZodType> = {};
    for (const [name, { field }] of this.state.fields[stage]) {
      const meta = {
        ...(field.description !== undefined && { description: field.description }),
        ...(field.default !== undefined && { default: field.default }),
      };
      const optional = valueSchema(field).optional();
      shape[name] = Object.keys(meta).length > 0 ? optional.meta(meta) : optional;
    }
    return shape;
  }

  /** Pick the option values out of a whole operation input. */
  pick(stage: OptionStage, input: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const name of this.state.fields[stage].keys()) {
      if (input[name] !== undefined) values[name] = input[name];
    }
    return values;
  }

  /**
   * Check option values against the type of `projectRef` and apply its defaults.
   *
   * An option the type does not declare, or a value its declaration rejects, is
   * the caller's mistake: `ApiError("usage")`, CLI exit 2.
   */
  resolve(
    projectRef: string,
    stage: OptionStage,
    values: Readonly<Record<string, unknown>> | undefined
  ): OptionValues {
    const type = this.typeOf(projectRef);
    const fields = this.fieldsOf(type, stage);
    const resolved: Record<string, string | boolean> = {};
    for (const [name, value] of Object.entries(values ?? {})) {
      if (value === undefined) continue;
      const field = fields[name];
      if (field === undefined) {
        throw new ApiError("usage", `"${name}" is not a ${stage} option of ${type} projects`);
      }
      const parsed = valueSchema(field).safeParse(value);
      if (!parsed.success) {
        throw new ApiError(
          "usage",
          `${name}: ${parsed.error.issues[0]?.message ?? "invalid value"}`
        );
      }
      resolved[name] = parsed.data;
    }
    for (const [name, field] of Object.entries(fields)) {
      if (resolved[name] === undefined && field.default !== undefined) {
        resolved[name] = field.default;
      }
    }
    return resolved;
  }
}

/** A sealed holder, for tests and for code that has its descriptions at hand. */
export function sealedProjectTypeOptions(
  ...descriptions: readonly ProjectTypeDescription[]
): ProjectTypeOptions {
  const options = new ProjectTypeOptions();
  options.seal(descriptions);
  return options;
}

/** The schema of a whole `options` record as it travels in an intent payload. */
export const optionValuesSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));
