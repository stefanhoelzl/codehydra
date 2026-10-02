/**
 * Typed module declarations: the handlers `defineHooks` / `defineEvents` accept are
 * typed from the operations' schema bundles, and the helpers are identities at runtime.
 *
 * Most assertions here are compile-time (`expectTypeOf`, checked by `pnpm check`): a
 * handler on an unknown operation, hook point or event, or one written against another
 * context, must not type-check.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  defineEvents,
  defineHooks,
  isIntent,
  type AppEventDeclarations,
  type AppHookDeclarations,
  type EventFor,
  type HookHandlerOf,
  type HookInput,
  type HooksOf,
} from "./declarations";
import {
  DELETE_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_DELETED,
  INTENT_DELETE_WORKSPACE,
  type DeleteWorkspacePayload,
  type FlushHookInput,
  type ShutdownHookResult,
  type WorkspaceDeletedPayload,
} from "./delete-workspace";
import { INTENT_OPEN_PROJECT, type OpenProjectPayload } from "./open-project";
import type { HookOutput } from "./lib/operation";
import type { Intent } from "./lib/types";

type ShutdownHandler = HookHandlerOf<typeof DELETE_WORKSPACE_OPERATION_ID, "shutdown">;

describe("typed hook declarations", () => {
  it("types a handler's context from its hook point, the operation's intent included", () => {
    type Flush = HookInput<typeof DELETE_WORKSPACE_OPERATION_ID, "flush">;
    expectTypeOf<Flush["blockingPids"]>().toEqualTypeOf<readonly number[]>();
    expectTypeOf<Flush["intent"]["payload"]>().toEqualTypeOf<DeleteWorkspacePayload>();
    expectTypeOf<Flush["intent"]["type"]>().toEqualTypeOf<typeof INTENT_DELETE_WORKSPACE>();
  });

  it("types a handler's result from its hook point", () => {
    expectTypeOf<{
      handler: () => Promise<HookOutput<ShutdownHookResult>>;
    }>().toExtend<ShutdownHandler>();
    expectTypeOf<{
      handler: () => Promise<HookOutput<{ readonly unrelated: number }>>;
    }>().not.toExtend<ShutdownHandler>();
  });

  it("rejects a handler written against another hook point's context", () => {
    // flush's context carries blockingPids; shutdown's does not.
    expectTypeOf<{
      handler: (ctx: FlushHookInput) => Promise<void>;
    }>().not.toExtend<ShutdownHandler>();
  });

  it("knows only the operations and hook points the schemas declare", () => {
    expectTypeOf<AppHookDeclarations>().toHaveProperty(DELETE_WORKSPACE_OPERATION_ID);
    expectTypeOf<AppHookDeclarations>().not.toHaveProperty("no-such-operation");
    expectTypeOf<HooksOf<typeof DELETE_WORKSPACE_OPERATION_ID>>().toHaveProperty("shutdown");
    expectTypeOf<HooksOf<typeof DELETE_WORKSPACE_OPERATION_ID>>().not.toHaveProperty("bogus");
  });

  it("returns the declarations unchanged", () => {
    const declarations = {
      [DELETE_WORKSPACE_OPERATION_ID]: { shutdown: { handler: async () => ({}) } },
    };
    expect(defineHooks(declarations)).toBe(declarations);
  });
});

describe("typed event declarations", () => {
  it("types a handler's event from its event type", () => {
    expectTypeOf<
      EventFor<typeof EVENT_WORKSPACE_DELETED>["payload"]
    >().toEqualTypeOf<WorkspaceDeletedPayload>();
    expectTypeOf<EventFor<typeof EVENT_WORKSPACE_DELETED>["type"]>().toEqualTypeOf<
      typeof EVENT_WORKSPACE_DELETED
    >();
  });

  it("knows only the event types operations declare", () => {
    expectTypeOf<AppEventDeclarations>().toHaveProperty(EVENT_WORKSPACE_DELETED);
    expectTypeOf<AppEventDeclarations>().not.toHaveProperty("no:such-event");
  });

  it("returns the declarations unchanged", () => {
    const declarations = { [EVENT_WORKSPACE_DELETED]: { handler: async () => {} } };
    expect(defineEvents(declarations)).toBe(declarations);
  });
});

describe("isIntent", () => {
  it("narrows an intent to the one its type names", () => {
    const intent: Intent = { type: INTENT_OPEN_PROJECT, payload: { path: "/p" } };
    expect(isIntent(intent, INTENT_OPEN_PROJECT)).toBe(true);
    expect(isIntent(intent, INTENT_DELETE_WORKSPACE)).toBe(false);
    if (isIntent(intent, INTENT_OPEN_PROJECT)) {
      expectTypeOf(intent.payload).toEqualTypeOf<OpenProjectPayload>();
    }
  });
});
