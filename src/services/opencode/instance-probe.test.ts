// @vitest-environment node
/**
 * Tests for InstanceProbe interface and HttpInstanceProbe implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpInstanceProbe, type InstanceProbe } from "./instance-probe";

describe("HttpInstanceProbe", () => {
  let probe: InstanceProbe;

  beforeEach(() => {
    probe = new HttpInstanceProbe();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("probe", () => {
    it("returns workspace path on successful probe", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            worktree: "/home/user/project/.worktrees/feature-1",
            directory: "/home/user/project",
          }),
          { status: 200 }
        )
      );

      const result = await probe.probe(8080);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("/home/user/project/.worktrees/feature-1");
      }
    });

    it("uses localhost URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ worktree: "/test", directory: "/test" }), {
          status: 200,
        })
      );

      await probe.probe(3000);

      expect(fetchSpy).toHaveBeenCalledWith("http://localhost:3000/path", expect.any(Object));
    });

    it("returns TIMEOUT error on fetch timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Aborted", "AbortError"));

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    });

    it("returns CONNECTION_REFUSED error on network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONNECTION_REFUSED");
      }
    });

    it("returns INVALID_RESPONSE error on malformed JSON", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_RESPONSE");
      }
    });

    it("returns NOT_OPENCODE error when missing worktree field", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ directory: "/test" }), { status: 200 })
      );

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_OPENCODE");
      }
    });

    it("returns NOT_OPENCODE error when worktree is not a string", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ worktree: 123, directory: "/test" }), {
          status: 200,
        })
      );

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_OPENCODE");
      }
    });

    it("returns NOT_OPENCODE error on non-200 status", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not Found", { status: 404 }));

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_OPENCODE");
      }
    });
  });
});
