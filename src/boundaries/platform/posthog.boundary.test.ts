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

function createFakeSdk(): {
  client: PostHogSdkClient;
  captures: CaptureCall[];
  exceptions: ExceptionCall[];
  identifies: IdentifyCall[];
  flushes: number;
  shutdowns: number;
} {
  const captures: CaptureCall[] = [];
  const exceptions: ExceptionCall[] = [];
  const identifies: IdentifyCall[] = [];
  const counters = { flushes: 0, shutdowns: 0 };

  const client: PostHogSdkClient = {
    capture: (params) => captures.push(params),
    captureException: (error, distinctId, additionalProperties) =>
      exceptions.push({ error, distinctId, additionalProperties }),
    identify: (params) => identifies.push(params),
    flush: async () => {
      counters.flushes += 1;
    },
    shutdown: async () => {
      counters.shutdowns += 1;
    },
  };

  return {
    client,
    captures,
    exceptions,
    identifies,
    get flushes() {
      return counters.flushes;
    },
    get shutdowns() {
      return counters.shutdowns;
    },
  };
}

function setup(opts?: { apiKey?: string | undefined }) {
  const fake = createFakeSdk();
  let factoryCalls = 0;
  const sdkFactory: PostHogSdkFactory = () => {
    factoryCalls += 1;
    return fake.client;
  };
  const boundary = createPostHogBoundary({
    logger: SILENT_LOGGER,
    apiKey: opts && "apiKey" in opts ? opts.apiKey : "test-key",
    host: "https://test.posthog.com",
    sdkFactory,
  });
  return { boundary, fake, getFactoryCalls: () => factoryCalls };
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
});
