---
name: config-key
description: Add, rename, deprecate, remove or change a CodeHydra config key (config.json / CH_* env / --flag) or a persisted state.json key — its default, type, validation, redaction, settings-dialog/`ch config` exposure, or migration. Use whenever a change touches `Config.register()` or `StateService.register()`.
---

# Config / state key

Reference: docs/CONFIGURATION.md. Code: `src/boundaries/platform/config.ts`, `state-service.ts`, `persisted-store.ts`, `store-definition.ts` (types, builders, semantics in JSDoc).

## 1. Pick the store

- **Config** (`config.json`, env, CLI; user-authored) — `deps.configService.register(...)` / `deps.config.register(...)`.
- **State** (`state.json`; the app writes it at runtime, no env/CLI, no `computedDefault`) — `deps.stateService.register(...)`. Loaded in `app:start` → `init` (`state-module.ts`): read it in `start` or later, never at construction.

## 2. Register in the owning module's factory

```ts
const fooConfig = deps.configService.register("area.foo-bar", {
  default: 30,
  description: "What it does (shown in --help, settings, ch config list)",
  applies: "live", // or omit = "restart"; settings-UI hint only
  ...storeNumber({ min: 1 }),
});
```

- Key: dot-separated, kebab-case. Keep the returned typed accessor; never read by string key. Read `.get()` where the value is used (not cached) if `applies: "live"`.
- Owned by no single module → register in `src/main.ts` beside `agent` and thread the accessor in.
- Builder (`store-definition.ts`): `storeBoolean()`, `storeNumber({min,max,integer})`, `storeEnum([...], {nullable: true}?)`, `storeEnumList([...])`, `storeString({nullable: true}?)`, `storeFolder()` (absolute path), `storeCustom({parse, validate, validValues?, settingsControl?})` (JSON/structured values). `parse` takes the raw env/CLI string, `validate` the JSON value; return `undefined` for invalid — the app then refuses to start with a message naming the key.
- `computedDefault: (ctx) => … | undefined` for build-dependent defaults (Config only; `ctx.isDevelopment`, `ctx.isPackaged`).

## 3. Exposure and secrets

- The builder attaches a `settingsControl`; that alone puts a Config key in the settings dialog **and** `ch config` (`isUserSetting`). Override it (e.g. `{ kind: "string" }`, `guarded-text`, `text` with `helpPanel`) or, for `storeCustom`, pass none to keep the key hidden. CLI-only actions go in `NON_SETTING_KEYS`.
- `redact: true` (or `(value, token) => projection`, must not throw) for secrets — masked in the settings field, `ch config`, bug reports, telemetry.
- `omit: true` for values edited in the clear that must stay out of diagnostics (`plugins.config`).

## 4. Rename, deprecate, remove

- **Rename**: register the new key with `legacyNames: { "old.key": (v) => translated | undefined }`. `Config.load()` moves the value in `config.json` (one way); env/CLI old names map through the new `parse()`. Drop the old name a release later.
- **Retire into something else** (state, another key): keep registering the old key with `deprecated: true` (`set()` throws, `get()` reads, hidden everywhere), migrate it in an app:start `migrations` hook, then `reset()` it. Example: `paths.workspaces` / `paths.workspaces-current` in `workspaces-root/module.ts`.
- **Remove**: delete the registration. An unknown key is stripped from `config.json` on load; in `state.json` it is logged and skipped.

## 5. Tests

- Module integration tests use `createMockConfig({ defaults: { "area.foo-bar": 5 } })` (`config.test-utils.ts`) / `createMockState({ values })` (`state.test-utils.ts`); `register()` returns a working accessor.
- Store-level behavior (parse, precedence, legacy, redaction): `config.integration.test.ts`, `state-service.integration.test.ts`.
- Cover the value's effect, an invalid value where `parse`/`validate` are custom, and any migration.

## 6. Docs

- docs/CONFIGURATION.md: add/update the key's entry (default, owner file, behavior), or remove it.
- User-visible keys (settings dialog, `ch config`, behavior a user sees): check docs/USER_GUIDE.md (Configuration and the feature's own section) and update it in the same change.
- `pnpm validate:fix`.
