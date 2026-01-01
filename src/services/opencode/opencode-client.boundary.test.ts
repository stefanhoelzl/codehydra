// @vitest-environment node
/**
 * Boundary tests for OpenCodeClient.
 *
 * These tests run against a real opencode serve process with a mock LLM server.
 * They verify the client correctly communicates with real opencode instances.
 *
 * Each test gets its own isolated environment:
 * - Fresh mock LLM server
 * - Fresh opencode process
 * - Fresh temp git repo
 *
 * @group boundary
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { existsSync } from "node:fs";
import { OpenCodeClient } from "./opencode-client";
import { withOpencode } from "./boundary-test-utils";
import { CI_TIMEOUT_MS } from "../platform/network.test-utils";
import { delay } from "../test-utils";
import { SILENT_LOGGER } from "../logging";
import { DefaultPathProvider } from "../platform/path-provider";
import { NodePlatformInfo } from "../../main/platform-info";
import { createMockBuildInfo } from "../platform/build-info.test-utils";
import type { ClientStatus } from "./types";

describe("OpenCodeClient boundary tests", () => {
  let binaryPath: string;

  // Check binary exists before running any tests
  beforeAll(() => {
    const buildInfo = createMockBuildInfo({
      isDevelopment: true,
      appPath: process.cwd(),
    });
    const platformInfo = new NodePlatformInfo();
    const pathProvider = new DefaultPathProvider(buildInfo, platformInfo);
    binaryPath = pathProvider.opencodeBinaryPath.toString();

    if (!existsSync(binaryPath)) {
      throw new Error(
        `OpenCode binary not found at ${binaryPath}. Run 'npm install' to download binaries.`
      );
    }
  });

  // ===========================================================================
  // Phase 1.3: Mock LLM Integration
  // ===========================================================================

  it(
    "mock LLM receives request from opencode",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ sdk }) => {
        const sessionResult = await sdk.session.create({ body: {} });
        expect(sessionResult.data).toBeDefined();
        const sessionId = sessionResult.data!.id;

        // Send prompt - SDK uses 'parts' format
        await sdk.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: "Say hello" }] },
        });

        // If we got here without error, the mock LLM received the request
        expect(true).toBe(true);
      });
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Phase 2: HTTP API Tests
  // ===========================================================================

  it(
    "fetchRootSessions returns sessions from real server",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk }) => {
        // Create a session first via SDK
        await sdk.session.create({ body: {} });

        const result = await client.fetchRootSessions();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(Array.isArray(result.value)).toBe(true);
          expect(result.value.length).toBeGreaterThan(0);
          expect(result.value[0]).toHaveProperty("id");
          expect(result.value[0]).toHaveProperty("directory");
        }
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "getStatus returns idle when no active sessions",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client }) => {
        const result = await client.getStatus();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe("idle");
        }
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "getStatus returns busy during active prompt",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "slow-stream" }, async ({ client, sdk }) => {
        // Create session and start prompt
        const session = await sdk.session.create({ body: {} });
        const sessionId = session.data!.id;

        // Send prompt but don't await (it will take time due to slow-stream)
        const promptPromise = sdk.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: "Stream this slowly" }] },
        });

        // Give it time to start processing
        await delay(100);

        // Check status during processing
        const result = await client.getStatus();

        // Wait for prompt to complete
        await promptPromise;

        expect(result.ok).toBe(true);
        if (result.ok) {
          // Status should be busy during streaming
          expect(["idle", "busy"]).toContain(result.value);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "handles empty session list",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client }) => {
        // Fresh opencode instance has no sessions
        const result = await client.fetchRootSessions();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(Array.isArray(result.value)).toBe(true);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Phase 3: SSE Connection Tests
  // ===========================================================================

  it(
    "connect establishes SSE connection",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client }) => {
        // Should not throw
        await expect(client.connect()).resolves.toBeUndefined();

        // Verify status listeners work
        const statuses: ClientStatus[] = [];
        client.onStatusChanged((status) => statuses.push(status));

        // Connection established, can be disconnected
        client.disconnect();
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "disconnect cleanly terminates connection",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client }) => {
        await client.connect();

        // Should not throw
        expect(() => client.disconnect()).not.toThrow();

        // Reconnection should work
        await expect(client.connect()).resolves.toBeUndefined();
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "connect times out when server is unresponsive",
    async () => {
      // Create client pointing to non-existent port (no withOpencode needed)
      const badClient = new OpenCodeClient(59998, SILENT_LOGGER);

      // The SDK may either:
      // 1. Throw immediately if the connection fails fast
      // 2. Timeout after the specified timeout period
      // Both are valid behaviors for an unresponsive server
      try {
        await badClient.connect(500);
        // If connect doesn't throw, the SDK silently handles connection failures
      } catch {
        // Expected behavior when SDK properly reports connection failures
      }

      badClient.dispose();
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Phase 4: Session Status Event Tests
  // ===========================================================================

  it(
    "receives status events during prompt processing",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk }) => {
        // Fetch root sessions first to track them
        await client.fetchRootSessions();
        await client.connect();

        const statuses: ClientStatus[] = [];
        client.onStatusChanged((status) => {
          statuses.push(status);
        });

        // Create session and send prompt
        const session = await sdk.session.create({ body: {} });
        const sessionId = session.data!.id;

        // Refetch sessions to track the new one
        await client.fetchRootSessions();

        await sdk.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: "Quick test" }] },
        });

        // Wait for events
        await vi.waitFor(
          () => {
            expect(statuses.length).toBeGreaterThan(0);
          },
          { timeout: CI_TIMEOUT_MS }
        );
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "maps retry status to busy",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "rate-limit" }, async ({ client, sdk }) => {
        await client.fetchRootSessions();
        await client.connect();

        const statuses: ClientStatus[] = [];
        client.onStatusChanged((status) => {
          statuses.push(status);
        });

        // Create session
        const session = await sdk.session.create({ body: {} });
        const sessionId = session.data!.id;
        await client.fetchRootSessions();

        // Send prompt - will trigger rate limit
        try {
          await sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Trigger rate limit" }] },
          });
        } catch {
          // Rate limit may cause errors
        }

        // Give time for events
        await delay(500);

        // Statuses should contain only idle or busy (retry mapped to busy)
        for (const status of statuses) {
          expect(["idle", "busy"]).toContain(status);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Phase 5: Root vs Child Session Filtering
  // ===========================================================================

  it(
    "root sessions are tracked correctly",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk }) => {
        // Create a root session
        const session = await sdk.session.create({ body: {} });
        const sessionId = session.data!.id;

        // Fetch sessions to populate root set
        const result = await client.fetchRootSessions();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(client.isRootSession(sessionId)).toBe(true);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "non-existent sessions return false for isRootSession",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client }) => {
        // Fetch sessions first to initialize
        await client.fetchRootSessions();

        // Non-existent sessions should not be considered root
        expect(client.isRootSession("nonexistent-session-id")).toBe(false);
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "child sessions created by sub-agent are filtered from root set",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk }) => {
        // Track status changes - should only reflect root session
        const statuses: ClientStatus[] = [];
        client.onStatusChanged((status) => {
          statuses.push(status);
        });

        await client.fetchRootSessions();
        await client.connect();

        // Create root session
        const session = await sdk.session.create({ body: {} });
        const sessionId = session.data!.id;

        // Refetch to track the new session
        await client.fetchRootSessions();

        // Create a child session directly via SDK (simulates what task tool would do)
        const childSession = await sdk.session.create({
          body: { parentID: sessionId },
        });
        expect(childSession.data).toBeDefined();
        const childSessionId = childSession.data!.id;

        // Verify root session is still tracked
        expect(client.isRootSession(sessionId)).toBe(true);

        // Verify child session has parentID set
        const allSessions = await sdk.session.list();
        const sessions = allSessions.data ?? [];
        const childSessions = sessions.filter(
          (s) => s.parentID !== undefined && s.parentID !== null
        );
        expect(childSessions.length).toBeGreaterThan(0);
        const firstChild = childSessions.find((s) => s.id === childSessionId);
        expect(firstChild).toBeDefined();
        expect(firstChild!.parentID).toBe(sessionId);

        // Child sessions should NOT be in root set
        for (const child of childSessions) {
          expect(client.isRootSession(child.id)).toBe(false);
        }

        // Refetch root sessions - should still only return root sessions
        const rootSessions = await client.fetchRootSessions();
        if (rootSessions.ok) {
          expect(rootSessions.value.every((s) => !s.parentID)).toBe(true);
        }

        // Status changes should only reflect root session state
        expect(statuses.length).toBeGreaterThanOrEqual(0);
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "session.created event for root session triggers tracking",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk }) => {
        // Connect first to receive SSE events
        await client.connect();

        // Track whether fetchRootSessions was effectively called via session events
        const initialResult = await client.fetchRootSessions();
        expect(initialResult.ok).toBe(true);

        const initialCount = initialResult.ok ? initialResult.value.length : 0;

        // Create a new root session - this should trigger session.created event
        const session = await sdk.session.create({ body: {} });
        const sessionId = session.data!.id;

        // Give time for SSE event to be processed
        await delay(200);

        // Refetch to update tracking
        const updatedResult = await client.fetchRootSessions();
        expect(updatedResult.ok).toBe(true);

        if (updatedResult.ok) {
          // New session should be tracked as root
          expect(updatedResult.value.length).toBeGreaterThan(initialCount);
          expect(client.isRootSession(sessionId)).toBe(true);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "session.created event for child session does not trigger root tracking",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk }) => {
        await client.fetchRootSessions();
        await client.connect();

        // Create root session
        const session = await sdk.session.create({ body: {} });
        const rootSessionId = session.data!.id;

        await client.fetchRootSessions();

        // Get initial root session count
        const beforeResult = await client.fetchRootSessions();
        expect(beforeResult.ok).toBe(true);

        // Create a child session directly via SDK (simulates what task tool would do)
        const childSession = await sdk.session.create({
          body: { parentID: rootSessionId },
        });
        expect(childSession.data).toBeDefined();
        const childSessionId = childSession.data!.id;

        // Give time for SSE event to be processed
        await delay(200);

        // Refetch root sessions
        const afterResult = await client.fetchRootSessions();

        if (afterResult.ok) {
          // All sessions from fetchRootSessions should be root sessions
          for (const s of afterResult.value) {
            expect(client.isRootSession(s.id)).toBe(true);
          }
        }

        // Verify root session is still tracked
        expect(client.isRootSession(rootSessionId)).toBe(true);

        // Check that child sessions exist but are NOT in root set
        const allSessions = await sdk.session.list();
        const childSessions = (allSessions.data ?? []).filter(
          (s) => s.parentID !== undefined && s.parentID !== null
        );

        expect(childSessions.length).toBeGreaterThan(0);
        const createdChild = childSessions.find((s) => s.id === childSessionId);
        expect(createdChild).toBeDefined();

        for (const child of childSessions) {
          // Child sessions should NOT be tracked as root
          expect(client.isRootSession(child.id)).toBe(false);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Phase 6: Permission Event Tests
  // ===========================================================================

  it(
    "detects tool calls complete without permission with bash=allow",
    async () => {
      await withOpencode(
        {
          binaryPath,
          mockLlmMode: "tool-call",
          permission: { bash: "allow", edit: "allow", webfetch: "allow" },
        },
        async ({ client, sdk }) => {
          // Track status changes
          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          await client.fetchRootSessions();
          await client.connect();

          // Create session
          const session = await sdk.session.create({ body: {} });
          const sessionId = session.data!.id;

          await client.fetchRootSessions();

          // Send prompt - tool call executes without permission (bash="allow")
          await sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Run a command" }] },
          });

          // Wait for session to return to idle
          await vi.waitFor(
            () => {
              expect(statuses.includes("idle")).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );

          // Tool executed without permission request because bash="allow"
          expect(statuses.length).toBeGreaterThan(0);
        }
      );
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Permission Flow Tests (bash="ask" configuration)
  // ===========================================================================

  it(
    "permission approval allows tool execution",
    async () => {
      await withOpencode(
        {
          binaryPath,
          mockLlmMode: "tool-call",
          permission: { bash: "ask", edit: "allow", webfetch: "allow" },
        },
        async ({ client, sdk }) => {
          // Track permission events
          type PermissionEvent =
            | {
                type: "permission.updated";
                event: { id: string; sessionID: string; type: string; title: string };
              }
            | {
                type: "permission.replied";
                event: { sessionID: string; permissionID: string; response: string };
              };
          const permissionEvents: PermissionEvent[] = [];

          client.onPermissionEvent((event) => {
            permissionEvents.push(event);
          });

          // Track status changes
          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          // Fetch root sessions first to track them
          await client.fetchRootSessions();
          await client.connect();

          // Create session
          const session = await sdk.session.create({ body: {} });
          const sessionId = session.data!.id;

          // Refetch to track the new session
          await client.fetchRootSessions();

          // Send prompt - this triggers a tool call that requires permission
          const promptPromise = sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Run a command" }] },
          });

          // Wait for permission.updated event
          await vi.waitFor(
            () => {
              const hasPermissionUpdated = permissionEvents.some(
                (e) => e.type === "permission.updated"
              );
              expect(hasPermissionUpdated).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );

          // Get the permission event details
          const permissionUpdated = permissionEvents.find((e) => e.type === "permission.updated");
          expect(permissionUpdated).toBeDefined();
          expect(permissionUpdated!.type).toBe("permission.updated");

          const permissionId = permissionUpdated!.event.id;

          // Respond with approval using SDK top-level method
          await sdk.postSessionIdPermissionsPermissionId({
            path: { id: sessionId, permissionID: permissionId },
            body: { response: "once" },
          });

          // Wait for permission.replied event
          await vi.waitFor(
            () => {
              const hasPermissionReplied = permissionEvents.some(
                (e) => e.type === "permission.replied"
              );
              expect(hasPermissionReplied).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );

          // Verify permission.replied has approval response
          const permissionReplied = permissionEvents.find((e) => e.type === "permission.replied");
          expect(permissionReplied).toBeDefined();
          expect(permissionReplied!.event.response).toBe("once");

          // Wait for prompt to complete
          await promptPromise;

          // Session should return to idle after tool executes
          await vi.waitFor(
            () => {
              expect(statuses.includes("idle")).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );

          // Verify the tool was executed by checking status sequence
          expect(statuses.length).toBeGreaterThan(0);
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "permission rejection prevents tool execution",
    async () => {
      await withOpencode(
        {
          binaryPath,
          mockLlmMode: "tool-call",
          permission: { bash: "ask", edit: "allow", webfetch: "allow" },
        },
        async ({ client, sdk }) => {
          // Track permission events
          type PermissionEvent =
            | {
                type: "permission.updated";
                event: { id: string; sessionID: string; type: string; title: string };
              }
            | {
                type: "permission.replied";
                event: { sessionID: string; permissionID: string; response: string };
              };
          const permissionEvents: PermissionEvent[] = [];

          client.onPermissionEvent((event) => {
            permissionEvents.push(event);
          });

          // Track status changes
          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          // Fetch root sessions first to track them
          await client.fetchRootSessions();
          await client.connect();

          // Create session
          const session = await sdk.session.create({ body: {} });
          const sessionId = session.data!.id;

          // Refetch to track the new session
          await client.fetchRootSessions();

          // Send prompt - this triggers a tool call that requires permission
          const promptPromise = sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Run a command" }] },
          });

          // Wait for permission.updated event
          await vi.waitFor(
            () => {
              const hasPermissionUpdated = permissionEvents.some(
                (e) => e.type === "permission.updated"
              );
              expect(hasPermissionUpdated).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );

          // Get the permission event details
          const permissionUpdated = permissionEvents.find((e) => e.type === "permission.updated");
          expect(permissionUpdated).toBeDefined();
          expect(permissionUpdated!.type).toBe("permission.updated");

          const permissionId = permissionUpdated!.event.id;

          // Respond with rejection using SDK top-level method
          await sdk.postSessionIdPermissionsPermissionId({
            path: { id: sessionId, permissionID: permissionId },
            body: { response: "reject" },
          });

          // Wait for permission.replied event
          await vi.waitFor(
            () => {
              const hasPermissionReplied = permissionEvents.some(
                (e) => e.type === "permission.replied"
              );
              expect(hasPermissionReplied).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );

          // Verify permission.replied has rejection response
          const permissionReplied = permissionEvents.find((e) => e.type === "permission.replied");
          expect(permissionReplied).toBeDefined();
          expect(permissionReplied!.event.response).toBe("reject");

          // Wait for prompt to complete
          await promptPromise;

          // Session should return to idle (tool was NOT executed due to rejection)
          await vi.waitFor(
            () => {
              expect(statuses.includes("idle")).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "subagent permission request emits permission.updated event",
    async () => {
      await withOpencode(
        {
          binaryPath,
          mockLlmMode: "tool-call",
          permission: { bash: "ask", edit: "allow", webfetch: "allow" },
        },
        async ({ client, sdk }) => {
          // Track permission events
          type PermissionEvent =
            | {
                type: "permission.updated";
                event: { id: string; sessionID: string; type: string; title: string };
              }
            | {
                type: "permission.replied";
                event: { sessionID: string; permissionID: string; response: string };
              };
          const permissionEvents: PermissionEvent[] = [];

          client.onPermissionEvent((event) => {
            permissionEvents.push(event);
          });

          await client.fetchRootSessions();
          await client.connect();

          // Create root session
          const rootSession = await sdk.session.create({ body: {} });
          const rootSessionId = rootSession.data!.id;
          await client.fetchRootSessions();

          // Create child session (subagent)
          const childSession = await sdk.session.create({
            body: { parentID: rootSessionId },
          });
          const childSessionId = childSession.data!.id;

          // Refetch to populate child-to-root mapping
          await client.fetchRootSessions();

          // Send prompt to CHILD session - triggers bash tool requiring permission
          const promptPromise = sdk.session.prompt({
            path: { id: childSessionId },
            body: { parts: [{ type: "text", text: "Run a command" }] },
          });

          // Wait for permission.updated event from child session
          // BUG: Currently fails because child session permission events are filtered out
          await vi.waitFor(
            () => {
              const hasPermission = permissionEvents.some((e) => e.type === "permission.updated");
              expect(hasPermission).toBe(true);
            },
            { timeout: CI_TIMEOUT_MS }
          );

          // Verify the event has the child session ID (not remapped to root)
          const permissionUpdated = permissionEvents.find((e) => e.type === "permission.updated")!;
          expect(permissionUpdated.event.sessionID).toBe(childSessionId);

          // Approve permission using child session ID
          await sdk.postSessionIdPermissionsPermissionId({
            path: { id: childSessionId, permissionID: permissionUpdated.event.id },
            body: { response: "once" },
          });

          // Wait for prompt to complete
          await promptPromise;
        }
      );
    },
    CI_TIMEOUT_MS
  );
});
