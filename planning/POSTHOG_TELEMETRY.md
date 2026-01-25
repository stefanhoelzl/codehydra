---
status: IMPLEMENTATION_REVIEW
last_updated: 2026-01-25
reviewers: [review-arch, review-quality, review-testing]
---

# POSTHOG_TELEMETRY

## Overview

- **Problem**: No visibility into CodeHydra usage - daily active users, version distribution, platform breakdown, or crash patterns
- **Solution**: Integrate PostHog for minimal product analytics with opt-out configuration
- **Risks**:
  - PostHog SDK uses internal HTTP (acceptable exception - third-party library like `ignore` package)
  - User privacy concerns (mitigated by opt-out and minimal data collection)
- **Alternatives Considered**:
  - TelemetryDeck (rejected - weaker Electron/Node.js support, smaller free tier)
  - Direct SDK usage without wrapper (rejected - less testable, violates project patterns)
  - Opt-in telemetry (considered - opt-out chosen for better data coverage, user can disable via config)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Main Process                                │
│                                                                     │
│  bootstrap()                                                        │
│       │                                                             │
│       ├─ buildInfo ──────────┐                                      │
│       ├─ platformInfo ───────┼──► TelemetryService ◄── logger       │
│       ├─ configService ──────┤         │               [telemetry]  │
│       ├─ __POSTHOG_API_KEY__ ┤         │                            │
│       └─ __POSTHOG_HOST__ ───┘         │                            │
│           (build-time inject)          │                            │
│                              ┌─────────┴─────────┐                  │
│                              │                   │                  │
│                    capture('app_launched')   captureError()         │
│                    { version, platform,      (uncaught exceptions)  │
│                      arch, isDev }                                  │
│                              │                   │                  │
│                              ├───────────────────┤                  │
│                              │                   │                  │
│                              ▼                   ▼                  │
│                    ┌─────────────────┐   ┌─────────────┐            │
│                    │  posthog-node   │   │   Logger    │            │
│                    │     SDK         │   │  (INFO)     │            │
│                    └────────┬────────┘   └─────────────┘            │
│                             │                                       │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  PostHog Cloud  │
                     │ (__POSTHOG_HOST__)│
                     └─────────────────┘
```

### Data Flow

1. On app startup, `TelemetryService` checks config and API key availability
2. If enabled and API key present, uses lazy initialization for PostHog client
3. Generates anonymous `distinct_id` if missing (in TelemetryService, persisted via ConfigService)
4. Captures `app_launched` event with version, platform, arch
5. **All captured events are also logged at INFO level** via injected logger
6. Registers global error handlers for unhandled exceptions (using `process.prependListener`)
7. On app shutdown, calls `posthog.shutdown()` to flush pending events

### Configuration

| Setting           | Source                         | Default                  | Description                                    |
| ----------------- | ------------------------------ | ------------------------ | ---------------------------------------------- |
| `POSTHOG_API_KEY` | Build-time env / GitHub secret | (none)                   | Project API key, telemetry disabled if missing |
| `POSTHOG_HOST`    | Build-time env                 | `https://eu.posthog.com` | PostHog instance URL (EU or US region)         |

**API Key Handling**:

- **Not in source code**: Key is never committed to the repository
- **GitHub Secret**: Stored as `POSTHOG_API_KEY` in GitHub repository secrets
- **CI Injection**: Injected via Vite `define` during CI builds
- **Development**: Developers use `.env.local` (gitignored) or telemetry is disabled
- **Fallback**: If key is missing at runtime, telemetry is silently disabled (no-op)

### Events Captured

| Event          | Properties                                     | Frequency              |
| -------------- | ---------------------------------------------- | ---------------------- |
| `app_launched` | `version`, `platform`, `arch`, `isDevelopment` | Once per session       |
| `error`        | `message`, `stack` (sanitized), `version`      | On unhandled exception |

### Error Stack Sanitization

Error stacks are sanitized before sending to PostHog:

- **Strip home directory**: Replace `/home/user/...` or `C:\Users\user\...` with `<home>/...`
- **Strip project paths**: Replace absolute project paths with relative paths
- **Truncate length**: Maximum 10 stack frames, 2000 characters total
- **No query parameters**: Strip query strings from any URLs in stack

### Anonymous Identity

- `distinct_id` is a random UUID generated on first launch
- Generated by TelemetryService, persisted via ConfigService in `config.json`
- Stored under `telemetry.distinctId`
- No PII collected (no user email, IP not stored by PostHog)

### Type Definitions

```typescript
// PostHog client factory for dependency injection
type PostHogClientFactory = (apiKey: string, options: { host: string }) => PostHogClient;

// TelemetryService dependencies (follows project pattern)
interface TelemetryServiceDeps {
  readonly buildInfo: BuildInfo;
  readonly platformInfo: PlatformInfo;
  readonly configService: ConfigService;
  readonly logger: Logger;
  readonly apiKey?: string;
  readonly host?: string;
  readonly postHogClientFactory?: PostHogClientFactory;
}

// PostHog client interface (subset of posthog-node)
interface PostHogClient {
  capture(params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
  shutdown(): Promise<void>;
}
```

## Implementation Steps

- [x] **Step 1: Add posthog-node dependency**
  - Run `pnpm add posthog-node`
  - Files affected: `package.json`, `pnpm-lock.yaml`
  - Test criteria: Package installs successfully

- [x] **Step 2: Create TelemetryService interface and types**
  - Create `src/services/telemetry/types.ts`
  - Define `TelemetryService` interface with `capture()`, `captureError()`, `shutdown()`
  - Define `TelemetryServiceDeps` interface (see Type Definitions above)
  - Define `PostHogClientFactory` type
  - Define `PostHogClient` interface (subset we use)
  - Add `"telemetry"` to `LoggerName` type in `src/services/logging/types.ts`
  - Files affected: `src/services/telemetry/types.ts`, `src/services/logging/types.ts`
  - Test criteria: Types compile without error

- [x] **Step 3: Extend ConfigService with telemetry settings**
  - Update `AppConfig` interface in `src/services/config/types.ts`:
    ```typescript
    telemetry?: {
      enabled: boolean;
      distinctId?: string;
    }
    ```
  - Update `DEFAULT_APP_CONFIG` to include `telemetry: { enabled: true }`
  - Update `validateConfig()` to accept and validate the new `telemetry` field:
    - `telemetry.enabled` must be boolean
    - `telemetry.distinctId` must be string or undefined
  - **Note**: ConfigService only persists config, does NOT generate distinctId
  - Files affected: `src/services/config/config-service.ts`, `src/services/config/types.ts`
  - Test criteria: Config loads with telemetry defaults, validation accepts new field

- [x] **Step 4: Implement PostHogTelemetryService**
  - Create `src/services/telemetry/posthog-telemetry-service.ts`
  - Constructor receives `TelemetryServiceDeps` object (follows project pattern)
  - Inject `PostHogClientFactory` for testability (default: creates real PostHog client)
  - Use **lazy initialization**: PostHog client created on first `capture()` call, not in constructor
  - Generate `distinctId` on first capture if missing, persist via ConfigService
  - Implement `capture()`, `captureError()`, `shutdown()`
  - Implement `sanitizeStack()` private method (see Error Stack Sanitization)
  - **Log all captured events at INFO level**: `this.logger.info('Telemetry event', { event, ...properties })`
  - If `apiKey` is undefined/empty, service operates in no-op mode (no events sent)
  - Add privacy comment: "Do NOT log user paths or PII"
  - Files affected: `src/services/telemetry/posthog-telemetry-service.ts`
  - Test criteria: Service instantiates, events captured when enabled, events logged at INFO, no-op when disabled or no API key

- [x] **Step 5: Create mock PostHog client for testing**
  - Create `src/services/telemetry/posthog-client.state-mock.ts`
  - Define `PostHogClientMockState` interface:
    ```typescript
    interface PostHogClientMockState extends MockState {
      readonly capturedEvents: readonly CapturedEvent[];
      readonly flushed: boolean;
      readonly shutdownCalled: boolean;
      snapshot(): Snapshot;
      toString(): string;
    }
    ```
  - Implement in-memory event capture with behavioral state
  - Add custom matchers: `toHaveCaptured(eventName)`, `toHaveCapturedError()`
  - Export `createMockPostHogClientFactory()` that returns mock with `$` state accessor
  - Files affected: `src/services/telemetry/posthog-client.state-mock.ts`
  - Test criteria: Mock captures events, matchers work correctly

- [x] **Step 6: Create behavioral logger mock for testing**
  - Create `src/services/telemetry/logger.state-mock.ts` (or extend existing if available)
  - Define `LoggerMockState` with `loggedEntries` array
  - Add custom matcher: `toHaveLoggedAtInfo(properties)`
  - Files affected: `src/services/telemetry/logger.state-mock.ts`
  - Test criteria: Logger mock captures log calls with level and properties

- [x] **Step 7: Write integration tests**
  - Create `src/services/telemetry/posthog-telemetry-service.integration.test.ts`
  - Use behavioral mocks for PostHogClient and Logger
  - Use real ConfigService with FileSystemLayer mock (not ConfigService mock)
  - Reset mocks in `beforeEach` using `$.reset()` pattern
  - Test cases:
    - Captures app_launched when enabled
    - No-op when telemetry disabled in config
    - No-op when API key is missing
    - Captures unhandled errors
    - Sanitizes user paths from error stacks
    - Shutdown flushes events
    - Uses persisted distinctId across restarts
    - Logs all events at INFO level (via behavioral logger mock)
  - Files affected: `src/services/telemetry/posthog-telemetry-service.integration.test.ts`
  - Test criteria: All tests pass

- [x] **Step 8: Wire TelemetryService into bootstrap**
  - Create service after `configService` in `bootstrap()`, between lines 697-699 in `src/main/index.ts`
  - Call `telemetryService.capture('app_launched', { ... })` after initialization
  - Register error handlers using `process.prependListener()` (not `process.on()`) to capture before other handlers:
    - `process.prependListener('uncaughtException', ...)` - call `captureError()` then re-throw
    - `process.prependListener('unhandledRejection', ...)` - call `captureError()` then re-throw
  - Call `telemetryService.shutdown()` in app quit handler (ensure flush before exit)
  - Files affected: `src/main/index.ts`
  - Test criteria: Events appear in PostHog dashboard when running dev mode with `.env.local`

- [x] **Step 9: Configure PostHog build-time injection**
  - Add `__POSTHOG_API_KEY__` to Vite `define` config (reads from `process.env.POSTHOG_API_KEY`)
  - Add `__POSTHOG_HOST__` to Vite `define` config (reads from `process.env.POSTHOG_HOST`, default `https://eu.posthog.com`)
  - Add TypeScript declarations to `src/globals.d.ts` (or `vite-env.d.ts`):
    ```typescript
    declare const __POSTHOG_API_KEY__: string | undefined;
    declare const __POSTHOG_HOST__: string | undefined;
    ```
  - Add `.env.local` to `.gitignore` (for local development with key)
  - Add `.env.example` with placeholder values and comments
  - Update GitHub Actions workflow to pass secret to build step: `POSTHOG_API_KEY: ${{ secrets.POSTHOG_API_KEY }}`
  - Files affected: `vite.config.ts`, `.env.example`, `.gitignore`, `.github/workflows/build.yml`, `src/globals.d.ts`
  - Test criteria:
    - CI builds inject key from GitHub secret
    - Local dev without `.env.local` runs with telemetry disabled (no-op)
    - Key never appears in source or logs
    - TypeScript compiles without errors for global constants

- [x] **Step 10: Update documentation**
  - Update `docs/ARCHITECTURE.md` App Services table to include:
    | TelemetryService | PostHog analytics for DAU, version, platform, errors | Implemented |
  - Update `CLAUDE.md` to note that `posthog-node` SDK's internal HTTP is an acceptable exception (like `ignore` package) since it's a third-party library with no I/O abstraction needed
  - Files affected: `docs/ARCHITECTURE.md`, `CLAUDE.md`
  - Test criteria: Documentation accurately reflects new service

## Testing Strategy

### Integration Tests

Test behavior through TelemetryService with behavioral mocks. Reset all mocks in `beforeEach` using `$.reset()`.

| #   | Test Case                          | Entry Point                       | Boundary Mocks      | Behavior Verified                                                  |
| --- | ---------------------------------- | --------------------------------- | ------------------- | ------------------------------------------------------------------ |
| 1   | Captures app_launched when enabled | `TelemetryService.capture()`      | PostHogClient       | `expect(mock).toHaveCaptured('app_launched')`                      |
| 2   | No-op when telemetry disabled      | `TelemetryService.capture()`      | PostHogClient       | `expect(mock).not.toHaveCaptured(...)`                             |
| 3   | No-op when API key missing         | `TelemetryService.capture()`      | PostHogClient       | `expect(mock).not.toHaveCaptured(...)`                             |
| 4   | Captures error on exception        | `TelemetryService.captureError()` | PostHogClient       | `expect(mock).toHaveCapturedError()`                               |
| 5   | Sanitizes user paths from stacks   | `TelemetryService.captureError()` | PostHogClient       | Stack does not contain home directory                              |
| 6   | Shutdown flushes pending events    | `TelemetryService.shutdown()`     | PostHogClient       | `expect(mock.$.flushed).toBe(true)`                                |
| 7   | Uses persisted distinctId          | Constructor                       | FileSystemLayer     | Same ID in config after restart                                    |
| 8   | Logs events at INFO level          | `TelemetryService.capture()`      | Logger (behavioral) | `expect(loggerMock).toHaveLoggedAtInfo({ event: 'app_launched' })` |

### Boundary Tests

**Not required.** The `posthog-node` SDK is a well-tested third-party library. Our integration tests verify correct SDK usage via behavioral mocks. Actual network delivery is the SDK's responsibility.

Sending real events would pollute production analytics, so we skip boundary tests for this service.

### Manual Testing Checklist

- [ ] Fresh install: telemetry enabled by default, distinctId generated
- [ ] Set `telemetry.enabled: false` in config.json: no events sent
- [ ] Run without API key (no `.env.local`): telemetry disabled, no errors
- [ ] Cause unhandled exception: error event captured with sanitized stack
- [ ] Check PostHog dashboard: see app_launched events with correct properties
- [ ] Check app logs: telemetry events appear at INFO level with `[telemetry]` scope

## Dependencies

| Package        | Purpose                           | Approved |
| -------------- | --------------------------------- | -------- |
| `posthog-node` | PostHog Node.js SDK for analytics | [x]      |

**User must approve all dependencies before implementation begins.**
**Dependencies are installed via `pnpm add <package>` to use the latest versions.**

**Note**: The `posthog-node` SDK uses internal HTTP calls. This is an acceptable exception to the External System Access Rules (similar to the `ignore` package) because it's a third-party library and we don't need to abstract its internal networking.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Add TelemetryService to App Services table                                                |
| `CLAUDE.md`            | Add note that `posthog-node` SDK is acceptable exception for HTTP (like `ignore` package) |

### New Documentation Required

None.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Integration tests pass
- [ ] Manual testing checklist complete
- [ ] Events visible in PostHog dashboard (with `.env.local` configured)
- [ ] Events logged at INFO level (visible in app logs)
- [ ] GitHub secret `POSTHOG_API_KEY` configured
- [ ] Documentation updated (ARCHITECTURE.md, CLAUDE.md)
- [ ] CI passed
