// @vitest-environment node
/**
 * Tests for InstanceProbe interface and HttpInstanceProbe implementation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpInstanceProbe, type InstanceProbe } from "./instance-probe";
import { type HttpClient, type HttpRequestOptions } from "../platform/network";
import { createMockHttpClient } from "../platform/network.test-utils";

describe("HttpInstanceProbe", () => {
  let probe: InstanceProbe;
  let mockHttpClient: HttpClient;

  beforeEach(() => {
    mockHttpClient = createMockHttpClient({
      response: new Response(JSON.stringify({ worktree: "/test", directory: "/test" }), {
        status: 200,
      }),
    });
    probe = new HttpInstanceProbe(mockHttpClient);
  });

  describe("constructor", () => {
    it("accepts HttpClient", () => {
      const httpClient = createMockHttpClient();
      const instanceProbe = new HttpInstanceProbe(httpClient);
      expect(instanceProbe).toBeDefined();
    });

    it("accepts optional timeout", () => {
      const httpClient = createMockHttpClient();
      const instanceProbe = new HttpInstanceProbe(httpClient, 10000);
      expect(instanceProbe).toBeDefined();
    });
  });

  describe("probe", () => {
    it("returns workspace path on successful probe", async () => {
      mockHttpClient = createMockHttpClient({
        response: new Response(
          JSON.stringify({
            worktree: "/home/user/project/.worktrees/feature-1",
            directory: "/home/user/project",
          }),
          { status: 200 }
        ),
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      const result = await probe.probe(8080);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("/home/user/project/.worktrees/feature-1");
      }
    });

    it("uses localhost URL with correct port", async () => {
      let capturedUrl: string | undefined;
      mockHttpClient = createMockHttpClient({
        implementation: async (url: string) => {
          capturedUrl = url;
          return new Response(JSON.stringify({ worktree: "/test", directory: "/test" }), {
            status: 200,
          });
        },
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      await probe.probe(3000);

      expect(capturedUrl).toBe("http://localhost:3000/path");
    });

    it("uses httpClient.fetch() with correct URL", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ worktree: "/test", directory: "/test" }), { status: 200 })
        );
      mockHttpClient = { fetch: fetchMock };
      probe = new HttpInstanceProbe(mockHttpClient);

      await probe.probe(8080);

      expect(fetchMock).toHaveBeenCalledWith("http://localhost:8080/path", expect.any(Object));
    });

    it("uses configured timeout", async () => {
      let capturedOptions: HttpRequestOptions | undefined;
      mockHttpClient = createMockHttpClient({
        implementation: async (_url: string, options?: HttpRequestOptions) => {
          capturedOptions = options;
          return new Response(JSON.stringify({ worktree: "/test", directory: "/test" }), {
            status: 200,
          });
        },
      });
      probe = new HttpInstanceProbe(mockHttpClient, 10000);

      await probe.probe(8080);

      expect(capturedOptions?.timeout).toBe(10000);
    });

    it("uses default timeout when not specified", async () => {
      let capturedOptions: HttpRequestOptions | undefined;
      mockHttpClient = createMockHttpClient({
        implementation: async (_url: string, options?: HttpRequestOptions) => {
          capturedOptions = options;
          return new Response(JSON.stringify({ worktree: "/test", directory: "/test" }), {
            status: 200,
          });
        },
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      await probe.probe(8080);

      expect(capturedOptions?.timeout).toBe(5000);
    });

    it("returns TIMEOUT error on fetch timeout", async () => {
      mockHttpClient = createMockHttpClient({
        error: new DOMException("Aborted", "AbortError"),
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
    });

    it("returns CONNECTION_REFUSED error on network error", async () => {
      mockHttpClient = createMockHttpClient({
        error: new Error("fetch failed"),
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONNECTION_REFUSED");
      }
    });

    it("returns INVALID_RESPONSE error on malformed JSON", async () => {
      mockHttpClient = createMockHttpClient({
        response: new Response("not json", { status: 200 }),
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_RESPONSE");
      }
    });

    it("returns NOT_OPENCODE error when missing worktree field", async () => {
      mockHttpClient = createMockHttpClient({
        response: new Response(JSON.stringify({ directory: "/test" }), { status: 200 }),
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_OPENCODE");
      }
    });

    it("returns NOT_OPENCODE error when worktree is not a string", async () => {
      mockHttpClient = createMockHttpClient({
        response: new Response(JSON.stringify({ worktree: 123, directory: "/test" }), {
          status: 200,
        }),
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_OPENCODE");
      }
    });

    it("returns NOT_OPENCODE error on non-200 status", async () => {
      mockHttpClient = createMockHttpClient({
        response: new Response("Not Found", { status: 404 }),
      });
      probe = new HttpInstanceProbe(mockHttpClient);

      const result = await probe.probe(8080);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_OPENCODE");
      }
    });
  });
});
