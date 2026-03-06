// @vitest-environment node

import { describe, it, expect } from "vitest";
import { SILENT_LOGGER } from "../../../services/logging";
import { createMockHttpClient } from "../../../services/platform/http-client.state-mock";
import { createYouTrackSource } from "./youtrack-source";

// =============================================================================
// YouTrack API Response Helpers
// =============================================================================

const BASE_URL = "https://youtrack.example.com";

function issuesResponse(
  issues: Array<{
    id: string;
    idReadable: string;
    summary: string;
    description?: string;
  }>
): string {
  return JSON.stringify(
    issues.map((issue) => ({
      id: issue.id,
      idReadable: issue.idReadable,
      summary: issue.summary,
      description: issue.description ?? "",
      reporter: { login: "johndoe", fullName: "John Doe" },
      created: 1709000000000,
      updated: 1709100000000,
      resolved: null,
      project: { id: "0-1", name: "My Project", shortName: "PROJ" },
      customFields: [],
    }))
  );
}

// =============================================================================
// Constants
// =============================================================================

const YOUTRACK_FIELDS =
  "id,idReadable,summary,description,reporter(login,fullName),created,updated,resolved,project(id,name,shortName),customFields(name,value(name))";
const DEFAULT_QUERY = "for:me State: {In Progress}";
const ISSUES_URL = `${BASE_URL}/api/issues?query=${encodeURIComponent(DEFAULT_QUERY)}&fields=${encodeURIComponent(YOUTRACK_FIELDS)}`;

// =============================================================================
// Tests
// =============================================================================

describe("YouTrackSource", () => {
  function createSource() {
    const httpClient = createMockHttpClient();
    const source = createYouTrackSource({
      httpClient,
      logger: SILENT_LOGGER,
    });

    return { source, httpClient };
  }

  function configureSource(source: ReturnType<typeof createYouTrackSource>) {
    source.onConfigUpdated({
      "experimental.youtrack.base-url": BASE_URL,
      "experimental.youtrack.token": "perm:test-token",
      "experimental.youtrack.query": DEFAULT_QUERY,
    });
  }

  describe("configDefinitions", () => {
    it("returns 3 config keys", () => {
      const { source } = createSource();
      const defs = source.configDefinitions();
      expect(defs).toHaveLength(3);
      expect(defs.map((d) => d.name)).toEqual([
        "experimental.youtrack.base-url",
        "experimental.youtrack.token",
        "experimental.youtrack.query",
      ]);
    });
  });

  describe("isConfigured", () => {
    it("returns false when no config is set", () => {
      const { source } = createSource();
      expect(source.isConfigured()).toBe(false);
    });

    it("returns false when only some keys are set", () => {
      const { source } = createSource();
      source.onConfigUpdated({ "experimental.youtrack.base-url": BASE_URL });
      expect(source.isConfigured()).toBe(false);
    });

    it("returns true when all 3 keys are set", () => {
      const { source } = createSource();
      configureSource(source);
      expect(source.isConfigured()).toBe(true);
    });
  });

  describe("initialize", () => {
    it("always returns true", async () => {
      const { source } = createSource();
      expect(await source.initialize()).toBe(true);
    });
  });

  describe("poll", () => {
    it("returns empty result when no issues match", async () => {
      const { source, httpClient } = createSource();
      configureSource(source);

      httpClient.setResponse(ISSUES_URL, { body: issuesResponse([]) });

      const result = await source.poll(new Set());

      expect(result.activeKeys.size).toBe(0);
      expect(result.newItems).toHaveLength(0);
    });

    it("returns new items for issues not in trackedKeys", async () => {
      const { source, httpClient } = createSource();
      configureSource(source);

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      const result = await source.poll(new Set());

      const expectedKey = `${BASE_URL}/api/issues/2-123`;
      expect(result.activeKeys).toEqual(new Set([expectedKey]));
      expect(result.newItems).toHaveLength(1);
      expect(result.newItems[0]!.key).toBe(expectedKey);
      expect(result.newItems[0]!.url).toBe(`${BASE_URL}/issue/PROJ-123`);
      expect(result.newItems[0]!.data).toHaveProperty("summary", "Fix the bug");
    });

    it("skips already-tracked issues", async () => {
      const { source, httpClient } = createSource();
      configureSource(source);

      httpClient.setResponse(ISSUES_URL, {
        body: issuesResponse([{ id: "2-123", idReadable: "PROJ-123", summary: "Fix the bug" }]),
      });

      const trackedKey = `${BASE_URL}/api/issues/2-123`;
      const result = await source.poll(new Set([trackedKey]));

      expect(result.activeKeys).toEqual(new Set([trackedKey]));
      expect(result.newItems).toHaveLength(0);
    });

    it("returns empty on API failure", async () => {
      const { source, httpClient } = createSource();
      configureSource(source);

      httpClient.setResponse(ISSUES_URL, { status: 403, body: "Forbidden" });

      const result = await source.poll(new Set());

      expect(result.activeKeys.size).toBe(0);
      expect(result.newItems).toHaveLength(0);
    });
  });

  describe("dispose", () => {
    it("resets configured state", () => {
      const { source } = createSource();
      configureSource(source);
      expect(source.isConfigured()).toBe(true);

      source.dispose();
      expect(source.isConfigured()).toBe(false);
    });
  });
});
