// @vitest-environment node
/**
 * Integration tests for OpenCodeProvider.sendMessage.
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
    provider = new OpenCodeProvider("/workspace/feature-a", SILENT_LOGGER);
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
