/**
 * The New workspace form's add-project buttons, contributed by modules.
 *
 * Every button in front of the form's project dropdown is one module's
 * contribution: core's folder picker (view-module) and each project type's own
 * way in (git: clone from a URL). The form renders what is contributed and
 * runs what is picked; it knows no button of its own.
 *
 * Two operations:
 *
 * - `project:list-add-actions` — hook "list": each module answers with the
 *   buttons it contributes. Listed in the order the handlers run, which is the
 *   order the modules are registered in `src/main.ts`.
 * - `project:add` — hook "run": the module owning `action` runs its flow (a
 *   sub-dialog, a picker). It either opens the project itself and answers with
 *   it (`project`, null when the user backed out), or answers with what to open
 *   (`open`) and the operation dispatches project:open with it.
 *
 * Every handler selects itself on the action id; exactly one may answer.
 */

import { z } from "zod/v4";
import type { Operation, OperationContext, OperationSchemas, HookContext } from "./lib/operation";
import { type IntentOf } from "./lib/operation";
import { hookCtxSchema, projectPathSchema, projectSchema } from "./contract";
import { INTENT_OPEN_PROJECT, type OpenProjectIntent } from "./open-project";
import { throwHookErrors } from "./lib/hook-helpers";

export const INTENT_LIST_ADD_ACTIONS = "project:list-add-actions" as const;
export const LIST_ADD_ACTIONS_OPERATION_ID = "list-add-actions";
export const INTENT_ADD_PROJECT = "project:add" as const;
export const ADD_PROJECT_OPERATION_ID = "add-project";

// =============================================================================
// project:list-add-actions
// =============================================================================

/** One add-project button. */
export const addProjectActionSchema = z
  .object({
    /** Unique across modules: what `project:add` is dispatched with. */
    id: z.string().min(1),
    /** Codicon name. */
    icon: z.string().min(1),
    /** Tooltip, and the button's accessible name. */
    title: z.string().min(1),
  })
  .readonly();
export type AddProjectAction = z.infer<typeof addProjectActionSchema>;

const listAddActionsPayloadSchema = z.object({}).readonly();

const listAddActionsHookResultSchema = z
  .object({ actions: z.array(addProjectActionSchema).readonly().optional() })
  .readonly();

export const listAddActionsSchemas = {
  type: INTENT_LIST_ADD_ACTIONS,
  payload: listAddActionsPayloadSchema,
  result: z.array(addProjectActionSchema).readonly(),
  hooks: {
    list: {
      input: hookCtxSchema(listAddActionsPayloadSchema, {}),
      result: listAddActionsHookResultSchema,
    },
  },
} satisfies OperationSchemas;

export type ListAddActionsIntent = IntentOf<typeof listAddActionsSchemas>;
export type ListAddActionsHookResult = z.infer<typeof listAddActionsHookResultSchema>;

export class ListAddActionsOperation implements Operation<typeof listAddActionsSchemas> {
  readonly id = LIST_ADD_ACTIONS_OPERATION_ID;
  readonly schemas = listAddActionsSchemas;

  async execute(
    ctx: OperationContext<ListAddActionsIntent, typeof listAddActionsSchemas>
  ): Promise<readonly AddProjectAction[]> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results, errors } = await ctx.hooks.collect("list", hookCtx);
    throwHookErrors(errors, "project:list-add-actions list hooks failed");
    const actions = results.flatMap((result) => result.actions ?? []);
    const ids = new Set<string>();
    for (const action of actions) {
      if (ids.has(action.id)) throw new Error(`Two add-project actions are named "${action.id}"`);
      ids.add(action.id);
    }
    return actions;
  }
}

// =============================================================================
// project:add
// =============================================================================

const addProjectPayloadSchema = z.object({ action: z.string().min(1) }).readonly();

/** What to open, for a flow that leaves the opening to the operation. */
const openRequestSchema = z
  .object({
    /** Absent (with `git`): project:open asks for a folder itself (select-folder). */
    path: projectPathSchema.optional(),
    git: z.string().optional(),
  })
  .readonly();

const runHookResultSchema = z
  .object({
    /** The flow opened the project itself; null when the user backed out. */
    project: projectSchema.nullable().optional(),
    open: openRequestSchema.optional(),
  })
  .readonly();

export const addProjectSchemas = {
  type: INTENT_ADD_PROJECT,
  payload: addProjectPayloadSchema,
  /** null: nothing was opened (canceled, or left to finish in the background). */
  result: projectSchema.nullable(),
  hooks: {
    run: { input: hookCtxSchema(addProjectPayloadSchema, {}), result: runHookResultSchema },
  },
} satisfies OperationSchemas;

export type AddProjectIntent = IntentOf<typeof addProjectSchemas>;
export type RunAddActionHookResult = z.infer<typeof runHookResultSchema>;
type Project = z.infer<typeof projectSchema>;

export class AddProjectOperation implements Operation<typeof addProjectSchemas> {
  readonly id = ADD_PROJECT_OPERATION_ID;
  readonly schemas = addProjectSchemas;

  async execute(
    ctx: OperationContext<AddProjectIntent, typeof addProjectSchemas>
  ): Promise<Project | null> {
    const hookCtx: HookContext = { intent: ctx.intent };
    const { results, errors } = await ctx.hooks.collect("run", hookCtx);
    throwHookErrors(errors, "project:add run hooks failed");
    const answers = results.filter(
      (result) => result.project !== undefined || result.open !== undefined
    );
    if (answers.length === 0) {
      throw new Error(`No module runs the add-project action "${ctx.intent.payload.action}"`);
    }
    if (answers.length > 1) {
      throw new Error(
        `More than one module ran the add-project action "${ctx.intent.payload.action}"`
      );
    }
    const answer = answers[0]!;
    if (answer.open === undefined) return answer.project ?? null;

    // `initial`: the user is adding this project right now, so the add-project
    // worktree picker may interrupt.
    return ctx.dispatch<OpenProjectIntent>({
      type: INTENT_OPEN_PROJECT,
      payload: { ...answer.open, initial: true },
    });
  }
}
