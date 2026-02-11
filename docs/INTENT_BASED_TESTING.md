# Testing Guide for Intent–Operation–Hook Architecture

This document defines **how to test Modules and Operations** in an Intent–Operation–Hook architecture.

It is written for **coding agents** and assumes:

- The architecture described elsewhere is already implemented
- **Modules depend only on Providers**
- **Provider mocks already exist and are reliable**
- Dispatcher and registry are _not_ the primary test target

---

## Core Testing Philosophy

> **Test against contracts, not wiring.**

- Modules are tested **in isolation**
- Operations are tested **with mocked hooks**
- Dispatcher is tested **sparingly**
- No test relies on hook order unless explicitly encoded

---

## Test Layers (Strict Separation)

```
1. Module Contract Tests     ← MOST TESTS
2. Operation Orchestration   ← SOME TESTS
3. Dispatcher Integration   ← FEW TESTS
```

This document covers **1 and 2 only**.

---

## Definitions (Testing Context)

### Module

- Declares:
  - hooks
  - events
  - interceptors

- Depends only on **Providers**
- Has **no knowledge** of dispatcher or operations

### Operation

- Owns:
  - workflow
  - control flow
  - error handling
  - intent chaining

- Does **not** implement business logic
- Calls hooks and interprets their outcome

---

# 1. Module Tests (Primary)

## What You Test

You test **what the module promises**, not how it is wired.

For each module:

- ✅ Hook handlers
- ✅ Event handlers
- ✅ Interceptors
- ❌ Dispatcher
- ❌ Other modules
- ❌ Operations

---

## Module Test Rules

1. **Instantiate the module directly**
2. **Inject mocked providers**
3. **Call hook / event / interceptor functions directly**
4. **Assert observable behavior**
5. **Never use the dispatcher**

---

## Testing Hook Handlers

### Example Module

```ts
class KeepfilesModule {
  constructor(private fs: FileSystemProvider) {}

  hooks = {
    "workspace:create": {
      gather: async (ctx: { shared: any }) => {
        ctx.shared.keepFiles = await this.fs.readKeepfiles();
      },
    },
  };
}
```

---

### Test: Hook Behavior

```ts
it("contributes keepfiles to shared context", async () => {
  const fs = mockFileSystemProvider({
    readKeepfiles: async () => [".env", ".gitignore"],
  });

  const module = new KeepfilesModule(fs);

  const ctx = { shared: {} };

  await module.hooks["workspace:create"].gather(ctx);

  expect(ctx.shared.keepFiles).toEqual([".env", ".gitignore"]);
});
```

### Why This Is Correct

- No dispatcher
- No operation
- No hook ordering assumptions
- Pure contract verification

---

## Testing Hook Failure Behavior

Hooks may throw.
**Operations decide what that means.**
Modules only need to throw correctly.

```ts
it("throws if keepfiles cannot be read", async () => {
  const fs = mockFileSystemProvider({
    readKeepfiles: async () => {
      throw new Error("IO error");
    },
  });

  const module = new KeepfilesModule(fs);
  const ctx = { shared: {} };

  await expect(module.hooks["workspace:create"].gather(ctx)).rejects.toThrow("IO error");
});
```

---

## Testing Event Handlers

Event handlers are **pure side-effect consumers**.

### Example Module

```ts
class TelemetryModule {
  constructor(private telemetry: TelemetryProvider) {}

  events = {
    "foo:created": (e: { payload: { id: string } }) => {
      this.telemetry.track("foo_created", e.payload.id);
    },
  };
}
```

---

### Test

```ts
it("tracks foo creation event", () => {
  const telemetry = mockTelemetryProvider();
  const module = new TelemetryModule(telemetry);

  module.events["foo:created"]({
    type: "foo:created",
    payload: { id: "123" },
  });

  expect(telemetry.track).toHaveBeenCalledWith("foo_created", "123");
});
```

---

## Testing Interceptors

Interceptors are **pure intent guards**.

### Example

```ts
class PermissionModule {
  interceptors = [
    {
      before: async (intent) => {
        if (intent.payload.forbidden) return null;
        return intent;
      },
    },
  ];
}
```

---

### Test

```ts
it("blocks forbidden intents", async () => {
  const interceptor = new PermissionModule().interceptors[0];

  const result = await interceptor.before({
    type: "foo:create",
    payload: { forbidden: true },
  });

  expect(result).toBeNull();
});
```

---

## Optional: Module Contract Shape Tests

Useful for plugin systems.

```ts
it("declares expected hooks", () => {
  const module = new KeepfilesModule(mockFs());

  expect(module.hooks).toHaveProperty("workspace:create");
  expect(module.hooks["workspace:create"]).toHaveProperty("gather");
});
```

---

# 2. Operation Tests (Orchestration)

Operations are tested **independently of real modules**.

---

## What You Test

- Control flow decisions
- Error handling
- Intent chaining
- Event emission
- Reaction to hook failures

---

## What You Mock

- Hooks
- dispatch
- emit

---

## Operation Test Rules

1. **Never use real modules**
2. **Mock hooks as plain async functions**
3. **Explicitly control hook outcomes**
4. **Assert decisions, not side effects**

---

## Example Operation

```ts
class CreateFooOperation {
  readonly id = "foo:create";

  async execute(ctx) {
    const errors: Error[] = [];

    for (const hook of ctx.hooks.gather ?? []) {
      try {
        await hook(ctx);
      } catch (e) {
        errors.push(e as Error);
      }
    }

    if (errors.length > 0) {
      throw new Error("Creation failed");
    }

    ctx.emit({
      type: "foo:created",
      payload: { id: "abc" },
    });

    return { id: "abc" };
  }
}
```

---

## Test: Successful Flow

```ts
it("emits event and returns id when hooks succeed", async () => {
  const op = new CreateFooOperation();

  const ctx = {
    intent: { type: "foo:create", payload: {} },
    hooks: {
      gather: [async () => {}],
    },
    emit: vi.fn(),
    dispatch: vi.fn(),
  };

  const result = await op.execute(ctx);

  expect(result.id).toBe("abc");
  expect(ctx.emit).toHaveBeenCalledWith({
    type: "foo:created",
    payload: { id: "abc" },
  });
});
```

---

## Test: Hook Failure Handling

```ts
it("fails if any hook throws", async () => {
  const op = new CreateFooOperation();

  const ctx = {
    intent: { type: "foo:create", payload: {} },
    hooks: {
      gather: [
        async () => {
          throw new Error("boom");
        },
      ],
    },
    emit: vi.fn(),
    dispatch: vi.fn(),
  };

  await expect(op.execute(ctx)).rejects.toThrow("Creation failed");
});
```

---

## Test: Intent Chaining

```ts
it("dispatches setup intent when needed", async () => {
  const op = new StartAppOperation();

  const dispatch = vi.fn().mockResolvedValue({ retry: false });

  await op.execute({
    intent: { type: "app:start", payload: {} },
    hooks: {},
    emit: vi.fn(),
    dispatch,
  });

  expect(dispatch).toHaveBeenCalledWith({
    type: "app:setup",
    payload: {},
  });
});
```

---

# What NOT to Test

❌ Hook ordering
❌ Dispatcher internals
❌ Registry typing
❌ Other modules
❌ Provider implementations

Those belong elsewhere.

---

## Mental Model for Coding Agents

- **Modules = Libraries**
- **Operations = State machines**
- **Hooks = Data + side effects**
- **Tests mirror those roles**

If a test:

- Needs a dispatcher → ❌ too high-level
- Needs another module → ❌ wrong layer
- Asserts call order → ❌ invalid assumption

---

## Final Checklist for Coding Agents

Before writing a test, ask:

- Am I testing a **contract**?
- Can I remove the dispatcher?
- Can I replace hooks with plain functions?
- Am I asserting behavior, not wiring?

If yes → you’re writing the right test.
