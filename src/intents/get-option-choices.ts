/**
 * GetOptionChoicesOperation - The run-time choices of a project's create
 * options, for the New workspace dialog.
 *
 * A project type's select option may declare `choices: "dynamic"`
 * (`project-type-options.ts`): its choices, and the one to preselect, come from
 * the type here. The type may also suggest names for the core Name field, each
 * of which may set other options when picked (git: an existing branch, which
 * sets the base it was made from).
 *
 * One hook point, "list", answered by the project's own type:
 * - first with `fresh: false` — a fast answer, from what the type holds already
 *   when it can, so the form paints quickly;
 * - with `refresh`, project:refresh runs in the background, "list" is asked
 *   again with `fresh: true`, and `option-choices:updated` carries the result.
 *   That is the dialog's "cached first, spinner until the refresh confirms".
 *
 * Flow:
 * 1. Dispatch project:resolve for the project's id and path
 * 2. hooks.collect("list") → choices per field, name suggestions
 * 3. If refresh: background project:refresh → re-list → emit option-choices:updated
 * 4. Return the first answer
 */

import { z } from "zod/v4";
import type { DomainEvent } from "./lib/types";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, projectIdSchema, projectPathSchema, projectRefSchema } from "./contract";
import { INTENT_RESOLVE_PROJECT, type ResolveProjectIntent } from "./resolve-project";
import { INTENT_REFRESH_PROJECT, type RefreshProjectIntent } from "./refresh-project";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_GET_OPTION_CHOICES = "project:get-option-choices" as const;
export const EVENT_OPTION_CHOICES_UPDATED = "option-choices:updated" as const;
export const GET_OPTION_CHOICES_OPERATION_ID = "get-option-choices";

// =============================================================================
// Contract schemas
// =============================================================================

/** One choice of a dynamic select. */
export const dynamicChoiceSchema = z
  .object({
    value: z.string().min(1),
    /** Shown in the dialog; the value when absent. */
    label: z.string().optional(),
    /** The heading the choice is listed under. */
    group: z.string().optional(),
  })
  .readonly();
export type DynamicChoice = z.infer<typeof dynamicChoiceSchema>;

/** A dynamic select's choices, and the one to preselect. */
export const fieldChoicesSchema = z
  .object({
    choices: z.array(dynamicChoiceSchema).readonly(),
    default: z.string().optional(),
    /** Shown on the field when there is nothing to choose (e.g. "No base branches available"). */
    empty: z.string().optional(),
  })
  .readonly();
export type FieldChoices = z.infer<typeof fieldChoicesSchema>;

/** A suggestion for the Name field. */
export const nameSuggestionSchema = z
  .object({
    /** Unique among the suggestions; what the dropdown reports when picked. */
    value: z.string().min(1),
    /** The workspace name the suggestion gives. */
    label: z.string().min(1),
    group: z.string().optional(),
    /** Option values picking it sets, each only when it is one of that field's choices. */
    sets: z.record(z.string(), z.string()).readonly().optional(),
  })
  .readonly();
export type NameSuggestion = z.infer<typeof nameSuggestionSchema>;

export const getOptionChoicesPayloadSchema = z
  .object({
    projectRef: projectRefSchema,
    /** Also refresh from upstream in the background; the result arrives as option-choices:updated. */
    refresh: z.boolean().optional(),
  })
  .readonly();

const choicesShape = {
  /** By option name: only options declared `choices: "dynamic"`. */
  fields: z.record(z.string(), fieldChoicesSchema).readonly(),
  nameSuggestions: z.array(nameSuggestionSchema).readonly(),
};

export const getOptionChoicesResultSchema = z
  .object({ ...choicesShape, projectRef: projectRefSchema, projectId: projectIdSchema })
  .readonly();

export const optionChoicesUpdatedPayloadSchema = getOptionChoicesResultSchema;

export const listChoicesHookResultSchema = z
  .object({
    fields: choicesShape.fields.optional(),
    nameSuggestions: choicesShape.nameSuggestions.optional(),
  })
  .readonly();

/** Operation-added enrichment for the "list" hook point. */
const listChoicesEnrichmentSchema = z.object({
  projectRef: projectRefSchema,
  projectPath: projectPathSchema,
  /** True after a refresh: answer from upstream's current state, not a cache. */
  fresh: z.boolean(),
});
const listChoicesHookInputSchema = hookCtxSchema(
  getOptionChoicesPayloadSchema,
  listChoicesEnrichmentSchema.shape
);

export const schemas = {
  type: INTENT_GET_OPTION_CHOICES,
  payload: getOptionChoicesPayloadSchema,
  result: getOptionChoicesResultSchema,
  hooks: {
    list: { input: listChoicesHookInputSchema, result: listChoicesHookResultSchema },
  },
  events: {
    [EVENT_OPTION_CHOICES_UPDATED]: optionChoicesUpdatedPayloadSchema,
  },
} satisfies OperationSchemas;

// =============================================================================
// Types derived from the schemas
// =============================================================================

export type GetOptionChoicesPayload = z.infer<typeof getOptionChoicesPayloadSchema>;
export type GetOptionChoicesResult = z.infer<typeof getOptionChoicesResultSchema>;
export type GetOptionChoicesIntent = IntentOf<typeof schemas>;
export type OptionChoicesUpdatedPayload = z.infer<typeof optionChoicesUpdatedPayloadSchema>;
export type ListChoicesHookResult = z.infer<typeof listChoicesHookResultSchema>;
/** Whole input context for "list" handlers. */
export type ListChoicesHookInput = HookContext & z.infer<typeof listChoicesEnrichmentSchema>;

export interface OptionChoicesUpdatedEvent extends DomainEvent {
  readonly type: typeof EVENT_OPTION_CHOICES_UPDATED;
  readonly payload: OptionChoicesUpdatedPayload;
}

// =============================================================================
// Operation
// =============================================================================

export class GetOptionChoicesOperation implements Operation<typeof schemas> {
  readonly id = GET_OPTION_CHOICES_OPERATION_ID;
  readonly schemas = schemas;

  async execute(
    ctx: OperationContext<GetOptionChoicesIntent, typeof schemas>
  ): Promise<GetOptionChoicesResult> {
    const { projectRef, refresh } = ctx.intent.payload;
    const { projectId, projectPath } = await ctx.dispatch<ResolveProjectIntent>({
      type: INTENT_RESOLVE_PROJECT,
      payload: { projectRef },
    });

    const list = async (fresh: boolean): Promise<GetOptionChoicesResult> => {
      const listCtx: ListChoicesHookInput = { intent: ctx.intent, projectRef, projectPath, fresh };
      const { results, errors } = await ctx.hooks.collect("list", listCtx);
      throwHookErrors(errors, "project:get-option-choices list hooks failed");
      const fields: Record<string, FieldChoices> = {};
      const nameSuggestions: NameSuggestion[] = [];
      for (const result of results) {
        Object.assign(fields, result.fields);
        nameSuggestions.push(...(result.nameSuggestions ?? []));
      }
      return { fields, nameSuggestions, projectRef, projectId };
    };

    const first = await list(false);

    if (refresh) {
      // Fire-and-forget: the form shows the first answer with a spinner until
      // this one lands. A failed refresh still re-lists, so the spinner ends
      // on what is there locally rather than spinning on.
      void (async () => {
        try {
          await ctx.dispatch<RefreshProjectIntent>({
            type: INTENT_REFRESH_PROJECT,
            payload: { projectRef },
          });
        } catch {
          // Best-effort: what is there locally stands.
        }
        try {
          const fresh = await list(true);
          const event: OptionChoicesUpdatedEvent = {
            type: EVENT_OPTION_CHOICES_UPDATED,
            payload: fresh,
          };
          ctx.emit(event);
        } catch {
          // The list failing now is no worse than it failing first.
        }
      })();
    }

    return first;
  }
}
