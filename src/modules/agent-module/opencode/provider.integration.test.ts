// @vitest-environment node
/**
 * Integration tests for OpenCodeProvider.sendMessage and .sendPromptAsync.
 *
 * The provider builds its own OpenCodeClient; the client module is swapped for
 * one that runs the real client over the behavioral SDK mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSdkClientMock,
  createSdkFactoryMock,
  type MockSdkClient,
} from "./sdk-client.state-mock";
import type * as ClientModule from "./client";
import type { Logger } from "../../../boundaries/platform/logging";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import { OpenCodeProvider } from "./provider";
import { Path } from "../../../utils/path/path";
import { workspaceRefSchema } from "../../../intents/contract";

const sdk = vi.hoisted(() => ({ current: null as MockSdkClient | null }));

// The factory runs when ./provider first imports ./client — after the imports
// above, so the state mock is already there to use.
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>();
  class TestOpenCodeClient extends actual.OpenCodeClient {
    constructor(port: number, logger: Logger) {
      super(
        port,
        logger,
        createSdkFactoryMock(sdk.current!) as unknown as ClientModule.SdkClientFactory
      );
    }
  }
  return { ...actual, OpenCodeClient: TestOpenCodeClient };
});

describe("OpenCodeProvider.sendMessage", () => {
  const message = { text: "the build is green", from: "CodeHydra · workspace other" };
  let provider: OpenCodeProvider;

  beforeEach(async () => {
    sdk.current = createSdkClientMock();
    provider = new OpenCodeProvider(
      workspaceRefSchema.parse("ch::local::/workspace::feature-a"),
      new Path("/workspace/feature-a"),
      SILENT_LOGGER
    );
    await provider.connect(8080);
  });

  afterEach(() => {
    provider.dispose();
  });

  it("fails while the TUI is not attached", async () => {
    await expect(provider.sendMessage(message, { waitMs: 0 })).rejects.toThrow(
      /No OpenCode session is running/
    );
    expect(sdk.current!.$.prompts).toHaveLength(0);
  });

  it("queues the message on the primary session, the sender tagged on the first line", async () => {
    provider.markActive();

    await provider.sendMessage(message, { waitMs: 0 });

    const sessionId = provider.getSession()!.sessionId;
    expect(sdk.current!.$.prompts).toEqual([
      expect.objectContaining({
        sessionId,
        prompt: "[from CodeHydra · workspace other] the build is green",
        queued: true,
      }),
    ]);
  });

  it("waits for the TUI to attach", async () => {
    const sending = provider.sendMessage(message, { waitMs: 5000 });
    provider.markActive();
    await sending;

    expect(sdk.current!.$.prompts).toHaveLength(1);
  });

  it("fails again once the agent terminal closes", async () => {
    provider.markActive();
    provider.detachTui();

    await expect(provider.sendMessage(message, { waitMs: 0 })).rejects.toThrow(
      /No OpenCode session is running/
    );
  });

  it("surfaces a prompt the server did not accept", async () => {
    provider.markActive();
    sdk.current!.session.promptAsync = vi
      .fn()
      .mockResolvedValue({ data: undefined, error: { name: "NotFoundError" } });

    await expect(provider.sendMessage(message, { waitMs: 0 })).rejects.toThrow("NotFoundError");
  });
});

describe("OpenCodeProvider.sendPromptAsync", () => {
  let provider: OpenCodeProvider;

  beforeEach(async () => {
    sdk.current = createSdkClientMock();
    provider = new OpenCodeProvider(
      workspaceRefSchema.parse("ch::local::/workspace::feature-a"),
      new Path("/workspace/feature-a"),
      SILENT_LOGGER
    );
    await provider.connect(8080);
  });

  afterEach(() => {
    provider.dispose();
  });

  it("queues the prompt with the agent and model options", async () => {
    const session = await provider.createSession();
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const result = await provider.sendPromptAsync(session.value.id, "build feature X", {
      agent: "coder",
      model: { providerID: "anthropic", modelID: "claude-4" },
    });

    expect(result.ok).toBe(true);
    expect(sdk.current!.$.prompts).toEqual([
      expect.objectContaining({
        sessionId: session.value.id,
        prompt: "build feature X",
        queued: true,
        agent: "coder",
        model: { providerID: "anthropic", modelID: "claude-4" },
      }),
    ]);
  });

  it("makes a created session the primary one the TUI attaches to", async () => {
    // The regression: the initial prompt's fallback session stayed off the
    // primary, so the TUI attached elsewhere and its turn ran unwatched.
    const session = await provider.createSession();
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    expect(provider.getSession()?.sessionId).toBe(session.value.id);
    expect(provider.getEnvironmentVariables()).toMatchObject({
      _CH_OPENCODE_SESSION_ID: session.value.id,
    });
  });

  it("reports not connected without a client", async () => {
    const disconnected = new OpenCodeProvider(
      workspaceRefSchema.parse("ch::local::/workspace::feature-b"),
      new Path("/workspace/feature-b"),
      SILENT_LOGGER
    );

    const result = await disconnected.sendPromptAsync("ses-1", "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Not connected");
    expect(sdk.current!.$.prompts).toHaveLength(0);
  });
});
