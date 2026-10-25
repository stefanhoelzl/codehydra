/**
 * Focused tests for the test harness's latest-OpenCode-2 lookup.
 */

import { describe, it, expect } from "vitest";
import { OPENCODE_NPM_DIST_TAGS_URL, resolveLatestOpenCode2 } from "./ensure-binaries";
import { createMockHttpClient } from "../../boundaries/platform/http-client.state-mock";

describe("resolveLatestOpenCode2", () => {
  it("reads the latest dist-tag npm publishes for the 2.x CLI", async () => {
    const http = createMockHttpClient({
      responses: {
        [OPENCODE_NPM_DIST_TAGS_URL]: {
          body: JSON.stringify({ latest: "2.1.4", beta: "2.2.0-rc1" }),
        },
      },
    });

    await expect(resolveLatestOpenCode2(http)).resolves.toBe("2.1.4");
  });

  it("fails when npm answers without a latest tag", async () => {
    const http = createMockHttpClient({
      responses: { [OPENCODE_NPM_DIST_TAGS_URL]: { body: "{}" } },
    });

    await expect(resolveLatestOpenCode2(http)).rejects.toThrow(
      /Could not read the latest OpenCode 2/
    );
  });

  it("fails when npm cannot be reached", async () => {
    const http = createMockHttpClient({
      responses: { [OPENCODE_NPM_DIST_TAGS_URL]: { status: 500 } },
    });

    await expect(resolveLatestOpenCode2(http)).rejects.toThrow(/HTTP 500/);
  });
});
