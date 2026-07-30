/**
 * Boundary tests for PostHogBoundary - verifies it maps calls onto the
 * low-level posthog-node SDK correctly: lazy client creation, distinctId +
 * commonProps stamping, anonymous fallback, flush/shutdown lifecycle.
 *
 * The real boundary is exercised with an injected fake SDK client (the seam),
 * so no network client is constructed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createPostHogBoundary, type PostHogSdkClient, type PostHogSdkFactory } from "./posthog";
import { SILENT_LOGGER } from "./logging";

// ============================================================================
// Fake SDK client (records calls)
// ============================================================================

interface CaptureCall {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}
interface ExceptionCall {
  error: unknown;
  distinctId: string | undefined;
  additionalProperties: Record<string | number, unknown> | undefined;
}
interface IdentifyCall {
  distinctId: string;
  properties: Record<string, unknown>;
}

function createFakeSdk(opts?: { failDelivery?: boolean }): {
  client: PostHogSdkClient;
  captures: CaptureCall[];
  exceptions: ExceptionCall[];
  identifies: IdentifyCall[];
  flushes: number;
  shutdowns: number;
  shutdownTimeouts: (number | undefined)[];
} {
  const captures: CaptureCall[] = [];
  const exceptions: ExceptionCall[] = [];
  const identifies: IdentifyCall[] = [];
  const shutdownTimeouts: (number | undefined)[] = [];
  const counters = { flushes: 0, shutdowns: 0 };

  const client: PostHogSdkClient = {
    capture: (params) => captures.push(params),
    captureException: (error, distinctId, additionalProperties) =>
      exceptions.push({ error, distinctId, additionalProperties }),
    identify: (params) => identifies.push(params),
    flush: async () => {
      counters.flushes += 1;
      if (opts?.failDelivery) throw new Error("Network error while fetching PostHog");
    },
    shutdown: async (shutdownTimeoutMs) => {
      counters.shutdowns += 1;
      shutdownTimeouts.push(shutdownTimeoutMs);
      if (opts?.failDelivery) throw new Error("Timeout while shutting down PostHog");
    },
  };

  return {
    client,
    captures,
    exceptions,
    identifies,
    shutdownTimeouts,
    get flushes() {
      return counters.flushes;
    },
    get shutdowns() {
      return counters.shutdowns;
    },
  };
}

function setup(opts?: { apiKey?: string | undefined; failDelivery?: boolean }) {
  const fake = createFakeSdk({ failDelivery: opts?.failDelivery ?? false });
  const sdkOptions: Parameters<PostHogSdkFactory>[1][] = [];
  const sdkFactory: PostHogSdkFactory = (_apiKey, options) => {
    sdkOptions.push(options);
    return fake.client;
  };
  const boundary = createPostHogBoundary({
    logger: SILENT_LOGGER,
    apiKey: opts && "apiKey" in opts ? opts.apiKey : "test-key",
    host: "https://test.posthog.com",
    sdkFactory,
  });
  return { boundary, fake, sdkOptions, getFactoryCalls: () => sdkOptions.length };
}

// ============================================================================
// Tests
// ============================================================================

describe("PostHogBoundary", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it("does not create a client until the first send", () => {
    env.boundary.configure({ distinctId: "id-1", commonProps: { version: "1.0.0" } });
    expect(env.getFactoryCalls()).toBe(0);

    env.boundary.capture("evt");
    expect(env.getFactoryCalls()).toBe(1);

    env.boundary.capture("evt2");
    expect(env.getFactoryCalls()).toBe(1); // reused
  });

  it("stamps commonProps and distinctId onto capture()", () => {
    env.boundary.configure({
      distinctId: "id-1",
      commonProps: { version: "1.0.0", arch: "arm64" },
    });
    env.boundary.capture("app_launched", { agent: "claude" });

    expect(env.fake.captures).toEqual([
      {
        distinctId: "id-1",
        event: "app_launched",
        properties: { version: "1.0.0", arch: "arm64", agent: "claude" },
      },
    ]);
  });

  it("no-op capture() without a distinctId", () => {
    env.boundary.configure({ commonProps: { version: "1.0.0" } });
    env.boundary.capture("app_launched");
    expect(env.fake.captures).toHaveLength(0);
  });

  it("stamps commonProps onto captureException() with the configured id", () => {
    env.boundary.configure({ distinctId: "id-1", commonProps: { version: "1.0.0" } });
    const err = new Error("boom");
    env.boundary.captureException(err, { logs: "abc" });

    expect(env.fake.exceptions).toHaveLength(1);
    expect(env.fake.exceptions[0]!.error).toBe(err);
    expect(env.fake.exceptions[0]!.distinctId).toBe("id-1");
    expect(env.fake.exceptions[0]!.additionalProperties).toEqual({ version: "1.0.0", logs: "abc" });
  });

  it("uses an anonymous distinctId for captureException() when none configured", () => {
    env.boundary.configure({ commonProps: { version: "1.0.0" } });
    env.boundary.captureException(new Error("boom"));

    expect(env.fake.exceptions).toHaveLength(1);
    const id = env.fake.exceptions[0]!.distinctId;
    expect(typeof id).toBe("string");
    expect(id).not.toBe("");
  });

  it("identify() does NOT stamp commonProps", () => {
    env.boundary.configure({ distinctId: "id-1", commonProps: { version: "1.0.0" } });
    env.boundary.identify({ config: { agent: "claude" } });

    expect(env.fake.identifies).toEqual([
      { distinctId: "id-1", properties: { config: { agent: "claude" } } },
    ]);
  });

  it("no-op identify() without a distinctId", () => {
    env.boundary.configure({ commonProps: { version: "1.0.0" } });
    env.boundary.identify({ config: {} });
    expect(env.fake.identifies).toHaveLength(0);
  });

  it("is a silent no-op when no api key is configured", () => {
    const noKey = setup({ apiKey: undefined });
    noKey.boundary.configure({ distinctId: "id-1" });
    noKey.boundary.capture("evt");
    noKey.boundary.captureException(new Error("x"));
    noKey.boundary.identify({ config: {} });

    expect(noKey.getFactoryCalls()).toBe(0);
    expect(noKey.fake.captures).toHaveLength(0);
    expect(noKey.fake.exceptions).toHaveLength(0);
  });

  it("flush() before any send is a no-op (no client created)", async () => {
    await env.boundary.flush();
    expect(env.getFactoryCalls()).toBe(0);
    expect(env.fake.flushes).toBe(0);
  });

  it("flush() forwards to the client once created", async () => {
    env.boundary.configure({ distinctId: "id-1" });
    env.boundary.capture("evt");
    await env.boundary.flush();
    expect(env.fake.flushes).toBe(1);
  });

  it("shutdown() flushes+closes and a later send recreates the client", async () => {
    env.boundary.configure({ distinctId: "id-1" });
    env.boundary.capture("evt");
    await env.boundary.shutdown();
    expect(env.fake.shutdowns).toBe(1);

    env.boundary.capture("evt2");
    expect(env.getFactoryCalls()).toBe(2); // recreated after shutdown
  });

  // --------------------------------------------------------------------------
  // Unreachable host (offline, blocked egress). Telemetry must degrade quietly.
  // --------------------------------------------------------------------------

  it("bounds the SDK's request timeout and retries", () => {
    env.boundary.configure({ distinctId: "id-1" });
    env.boundary.capture("evt");

    const options = env.sdkOptions[0]!;
    expect(options.host).toBe("https://test.posthog.com");
    // Well under the SDK defaults (10s / 3 retries / 3s apart), which let a
    // single flush on a dead network run for ~40s.
    expect(options.requestTimeout).toBeLessThanOrEqual(5_000);
    expect(options.fetchRetryCount).toBeLessThanOrEqual(2);
    expect(options.fetchRetryDelay).toBeLessThanOrEqual(3_000);
  });

  it("flush() swallows a delivery failure instead of rejecting its caller", async () => {
    const offline = setup({ failDelivery: true });
    offline.boundary.configure({ distinctId: "id-1" });
    offline.boundary.capture("evt");

    await expect(offline.boundary.flush()).resolves.toBeUndefined();
    expect(offline.fake.flushes).toBe(1);
  });

  it("shutdown() swallows a delivery failure and still closes the client", async () => {
    const offline = setup({ failDelivery: true });
    offline.boundary.configure({ distinctId: "id-1" });
    offline.boundary.capture("evt");

    await expect(offline.boundary.shutdown()).resolves.toBeUndefined();

    // Client dropped despite the failure, so a later send starts a fresh one.
    offline.boundary.capture("evt2");
    expect(offline.getFactoryCalls()).toBe(2);
  });

  it("shutdown() caps how long the SDK may spend flushing at exit", async () => {
    env.boundary.configure({ distinctId: "id-1" });
    env.boundary.capture("evt");
    await env.boundary.shutdown();

    const timeout = env.fake.shutdownTimeouts[0];
    expect(timeout).toBeDefined();
    // The SDK default is 30s, which would hold the app:shutdown "stop" hook
    // (and therefore the quit) open on an unreachable network.
    expect(timeout!).toBeLessThanOrEqual(5_000);
  });
});
