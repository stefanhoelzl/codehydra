# Intent–Operation–Hook Architecture (General, Typed, Extensible)

This document defines a **general-purpose application architecture** intended for use by coding agents and human developers to build or extend applications with **clean architecture, strong typing, and explicit extensibility**.

The architecture is framework-agnostic and works especially well with TypeScript, Electron, backend services, and plugin-based systems.

---

## Core Principles

1. **All externally visible behavior starts with an Intent**
2. **1 Intent = 1 Operation** (enforced by registry)
3. **Operations orchestrate workflows, but do not implement business logic**
4. **Hooks, Events, and Interceptors are the only extension points**
5. **Hooks and Interceptors are unordered by default**
6. **Any ordering must be declared explicitly**
7. **Operations decide what happens next, based on hook outcomes**
8. **Modules never call each other**
9. **Composition happens only in the application shell**

---

## High-Level Flow

```
External Trigger (UI / IPC / System / Plugin)
        |
        v
      Intent (typed, registered)
        |
        v
   Dispatcher
        |
        |-- Interceptors (unordered, may cancel)
        |
        v
   Operation (1:1 with Intent)
        |
        |-- Hooks (unordered, exception-aware)
        |-- May dispatch child intents
        |-- Emits events
        |
        v
     Result
```

---

## Core Concepts

| Concept            | Responsibility                                             |
| ------------------ | ---------------------------------------------------------- |
| **Intent**         | Declarative request describing _what should happen_        |
| **Operation**      | Orchestrates the workflow for one intent                   |
| **Hook**           | Module-provided behavior contributing data or side effects |
| **Interceptor**    | Pre-execution check or transformation                      |
| **Event**          | Informational signal emitted after something happened      |
| **Module**         | Declares hooks, interceptors, and event subscribers        |
| **Dispatcher**     | Executes intents using the registry                        |
| **IntentRegistry** | Single source of truth mapping intent → operation          |

---

## Intent Registry (Single Source of Truth)

All typing, validation, and wiring derives from the registry.

```ts
interface IntentDefinition<TPayload, TResult, TOperation> {
  payload: TPayload;
  result: TResult;
  operation: new () => TOperation;
}

export const intentRegistry = {
  "foo:create": {
    payload: {} as { name: string },
    result: {} as { id: string },
    operation: CreateFooOperation,
  },

  "app:start": {
    payload: {} as {},
    result: {} as void,
    operation: StartAppOperation,
  },
} as const;

export type IntentId = keyof typeof intentRegistry;

export type Intent<K extends IntentId = IntentId> = {
  type: K;
  payload: (typeof intentRegistry)[K]["payload"];
};
```

✅ This enables **compile-time checking** of:

- Valid intent IDs
- Correct payloads
- Correct return types

---

## Dispatcher

The dispatcher is instantiated **with the registry** and therefore knows all intents and operations.

```ts
interface Dispatcher {
  registerModule(module: Module): void;

  dispatch<K extends IntentId>(intent: {
    type: K;
    payload: (typeof intentRegistry)[K]["payload"];
  }): Promise<(typeof intentRegistry)[K]["result"]>;
}
```

### Dispatcher Responsibilities

1. Validate intent ID against registry
2. Run **interceptors (unordered)**
3. Resolve the operation from the registry
4. Resolve hooks for the operation
5. Execute the operation
6. Deliver emitted events to subscribers

---

## Operation

An operation is a **pure orchestrator**.

- It decides _when_ hooks are invoked
- It decides _how failures are handled_
- It decides _whether to continue, retry, or stop_
- It may dispatch child intents

```ts
interface Operation<I extends Intent, R = void> {
  readonly id: I["type"];
  execute(ctx: OperationContext<I>): Promise<R>;
}
```

### Operation Context

```ts
interface OperationContext<I extends Intent> {
  readonly intent: I;

  dispatch<K extends IntentId>(intent: {
    type: K;
    payload: (typeof intentRegistry)[K]["payload"];
  }): Promise<(typeof intentRegistry)[K]["result"]>;

  emit(event: DomainEvent): void;

  hooks: ResolvedHooks;

  causation: {
    intentId: string;
    parentIntentId?: string;
  };
}
```

---

## Hooks

### Key Rule: **Hooks Are Unordered**

- No implicit order
- No registration order guarantees
- No reliance on execution order

If ordering is required, it must be:

- Explicitly encoded in hook IDs, **or**
- Explicitly orchestrated by the operation

### Hook Shape

```ts
type HookHandler<TContext = unknown> = (ctx: TContext) => Promise<void>;
```

Hooks may:

- Contribute data (via shared context)
- Perform side effects
- Throw errors to signal failure

---

## Hook Execution & Exception Handling

Operations decide **how hook failures are handled**.

### Recommended Pattern

```ts
async function runHooks(
  handlers: HookHandler[],
  ctx: HookExecutionContext
): Promise<{ errors: Error[] }> {
  const errors: Error[] = [];

  for (const handler of handlers) {
    try {
      await handler(ctx);
    } catch (e) {
      errors.push(e as Error);
    }
  }

  return { errors };
}
```

### Operation Chooses Strategy

Examples:

- **Fail-fast**: stop on first error
- **Best-effort**: collect errors, continue
- **Retry**: retry entire operation
- **Compensate**: run cleanup hooks
- **Abort**: cancel workflow

👉 Hooks **do not decide control flow**.
👉 Operations always decide.

---

## Interceptors

Interceptors run **before operation execution**.

### Rules

- Unordered
- No ordering guarantees
- First version should **not care about order**
- May modify intent or cancel it

```ts
interface IntentInterceptor {
  before(intent: Intent): Promise<Intent | null>;
}
```

If any interceptor returns `null`, the intent is canceled.

---

## Events

Events are **fire-and-forget signals**.

- No return value
- No ordering guarantees
- Cannot affect control flow

```ts
type DomainEvent =
  | { type: "foo:created"; payload: { id: string } }
  | { type: "app:started"; payload: {} };
```

---

## Modules

Modules are **pure declarations**.

They never execute on their own.

```ts
interface Module {
  hooks?: Record<string, Record<string, HookHandler>>;
  events?: Record<string, (event: DomainEvent) => void>;
  interceptors?: IntentInterceptor[];
}
```

The dispatcher (or composition root) wires everything.

---

## Explicit Ordering (When Needed)

If ordering is required, it must be **declared**, never implied.

### Option 1: Explicit Phases

```ts
hooks = {
  "foo:create": {
    "phase:validate": validate,
    "phase:write": write,
    "phase:notify": notify,
  },
};
```

Operation explicitly runs phases in order.

### Option 2: Separate Hook Points

```ts
operation.execute() {
  await runHooks(hooks.validate)
  await runHooks(hooks.execute)
  await runHooks(hooks.finalize)
}
```

---

## Intent Dispatching from Other Intents

> **Who dispatches child intents?**

✅ **Always the Operation**

Hooks may return information.
Operations decide whether to dispatch another intent.

```ts
const result = await ctx.dispatch({
  type: "app:setup",
  payload: {},
});

if (result.retry) {
  await ctx.dispatch({ type: "app:setup", payload: {} });
}
```

---

## Example: Complete Flow

### Operation

```ts
class CreateFooOperation implements Operation<Intent<"foo:create">, { id: string }> {
  readonly id = "foo:create";

  async execute(ctx: OperationContext<Intent<"foo:create">>) {
    const hookCtx = { shared: {} };

    const { errors } = await runHooks(ctx.hooks["foo:create"]?.["gather"] ?? [], hookCtx);

    if (errors.length > 0) {
      throw new Error("Foo creation failed");
    }

    const id = crypto.randomUUID();

    ctx.emit({ type: "foo:created", payload: { id } });

    return { id };
  }
}
```

### Module

```ts
class FooModule implements Module {
  hooks = {
    "foo:create": {
      gather: async (ctx) => {
        ctx.shared.name = "My Foo";
      },
    },
  };

  events = {
    "foo:created": (e) => {
      console.log("Created foo", e.payload.id);
    },
  };

  interceptors = [
    {
      before: async (intent) => {
        if (!intent.payload.name) return null;
        return intent;
      },
    },
  ];
}
```

### Composition

```ts
const dispatcher = new Dispatcher(intentRegistry);
dispatcher.registerModule(new FooModule());

await dispatcher.dispatch({
  type: "foo:create",
  payload: { name: "Test" },
});
```

---

## Summary Rules for Coding Agents

- **Never rely on hook order**
- **Never let hooks decide control flow**
- **Operations orchestrate, modules implement**
- **All behavior starts with an intent**
- **Use registry as the single source of truth**
- **Explicit is always better than implicit**
