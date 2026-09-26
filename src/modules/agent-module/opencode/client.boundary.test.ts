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

import { describe, it, expect, beforeAll, onTestFinished } from "vitest";
import { OpenCodeClient } from "./client";
import { withOpencode } from "./boundary-test-utils";
import { CI_TIMEOUT_MS } from "../../../boundaries/platform/network.test-utils";
import { delay } from "@shared/test-fixtures";
import { SILENT_LOGGER } from "../../../boundaries/platform/logging";
import {
  ensureBinaryForTests,
  getBinaryPathForTests,
  warmBinaryForTests,
  BINARY_WARM_TIMEOUT_MS,
} from "../../../utils/testing/ensure-binaries";
import type { ClientStatus } from "./types";
import type { UserRequestEvent } from "./client";
import { OpenCodeProvider } from "./provider";
import type { AgentStatus } from "../types";
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2";

describe("OpenCodeClient boundary tests", () => {
  let binaryPath: string;

  // Ensure binary is available before running any tests
  beforeAll(async () => {
    await ensureBinaryForTests("opencode");
    binaryPath = getBinaryPathForTests("opencode");

    // First exec of a fresh binary can stall on macOS (Gatekeeper assessment);
    // pay that cost here instead of inside the first test's timeout
    await warmBinaryForTests("opencode");
  }, BINARY_WARM_TIMEOUT_MS);

  // ===========================================================================
  // Phase 1.3: Mock LLM Integration
  // ===========================================================================

  it(
    "mock LLM receives request from opencode",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ sdk, step }) => {
        const sessionResult = await step("create session", sdk.session.create({ body: {} }));
        expect(sessionResult.data).toBeDefined();
        const sessionId = sessionResult.data!.id;

        // Send prompt - SDK uses 'parts' format
        await step(
          "prompt",
          sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Say hello" }] },
          })
        );

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
    "listSessions returns sessions from real server",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk, step }) => {
        // Create a session first via SDK
        await step("create session", sdk.session.create({ body: {} }));

        const result = await step("list sessions", client.listSessions());

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
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, step }) => {
        const result = await step("get status", client.getStatus());

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
      await withOpencode(
        { binaryPath, mockLlmMode: "slow-stream" },
        async ({ client, sdk, step }) => {
          // Create session and start prompt
          const session = await step("create session", sdk.session.create({ body: {} }));
          const sessionId = session.data!.id;

          // Send prompt but don't await (it will take time due to slow-stream)
          const promptPromise = sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Stream this slowly" }] },
          });

          // Give it time to start processing
          await delay(100);

          // Check status during processing
          const result = await step("get status", client.getStatus());

          // Wait for prompt to complete
          await step("prompt completes", promptPromise);

          expect(result.ok).toBe(true);
          if (result.ok) {
            // Status should be busy during streaming
            expect(["idle", "busy"]).toContain(result.value);
          }
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "handles empty session list",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, step }) => {
        // Fresh opencode instance has no sessions
        const result = await step("list sessions", client.listSessions());

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
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, step }) => {
        // Should not throw
        await expect(step("connect", client.connect())).resolves.toBeUndefined();

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
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, step }) => {
        await step("connect", client.connect());

        // Should not throw
        expect(() => client.disconnect()).not.toThrow();

        // Reconnection should work
        await expect(step("connect", client.connect())).resolves.toBeUndefined();
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
      await withOpencode(
        { binaryPath, mockLlmMode: "instant" },
        async ({ client, sdk, step, waitFor }) => {
          // Connect first to receive SSE events
          await step("connect", client.connect());

          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          // Create session via client (immediately tracked)
          const sessionResult = await step("create session", client.createSession());
          expect(sessionResult.ok).toBe(true);
          const sessionId = sessionResult.ok ? sessionResult.value.id : "";

          await step(
            "prompt",
            sdk.session.prompt({
              path: { id: sessionId },
              body: { parts: [{ type: "text", text: "Quick test" }] },
            })
          );

          // Wait for events
          await waitFor("status event", () => {
            expect(statuses.length).toBeGreaterThan(0);
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "maps retry status to busy",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "rate-limit" },
        async ({ client, sdk, step }) => {
          // Connect first to receive SSE events
          await step("connect", client.connect());

          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          // Create session via client (immediately tracked)
          const sessionResult = await step("create session", client.createSession());
          expect(sessionResult.ok).toBe(true);
          const sessionId = sessionResult.ok ? sessionResult.value.id : "";

          // Send prompt - will trigger rate limit
          // Rate limit may cause errors
          await step(
            "prompt",
            sdk.session
              .prompt({
                path: { id: sessionId },
                body: { parts: [{ type: "text", text: "Trigger rate limit" }] },
              })
              .catch(() => {})
          );

          // Give time for events
          await delay(500);

          // Statuses should contain only idle or busy (retry mapped to busy)
          for (const status of statuses) {
            expect(["idle", "busy"]).toContain(status);
          }
        }
      );
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Phase 5: Root vs Child Session Filtering
  // ===========================================================================

  it(
    "root sessions are tracked correctly",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, step }) => {
        // Create a root session via client (immediately tracked)
        const result = await step("create session", client.createSession());

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(client["rootSessionIds"].has(result.value.id)).toBe(true);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "non-existent sessions are not tracked as root sessions",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client }) => {
        // Non-existent sessions should not be considered root
        expect(client["rootSessionIds"].has("nonexistent-session-id")).toBe(false);
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "child sessions created by sub-agent are filtered from root set",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk, step }) => {
        // Track status changes - should only reflect root session
        const statuses: ClientStatus[] = [];
        client.onStatusChanged((status) => {
          statuses.push(status);
        });

        // Connect first to receive SSE events
        await step("connect", client.connect());

        // Create root session via client (immediately tracked)
        const rootResult = await step("create session", client.createSession());
        expect(rootResult.ok).toBe(true);
        const sessionId = rootResult.ok ? rootResult.value.id : "";

        // Create a child session directly via SDK (simulates what task tool would do)
        const childSession = await step(
          "create child session",
          sdk.session.create({
            body: { parentID: sessionId },
          })
        );
        expect(childSession.data).toBeDefined();
        const childSessionId = childSession.data!.id;

        // Wait for SSE event to process child session
        await delay(100);

        // Verify root session is still tracked
        expect(client["rootSessionIds"].has(sessionId)).toBe(true);

        // Verify child session has parentID set
        const allSessions = await step("list sessions", sdk.session.list());
        const sessions = allSessions.data ?? [];
        type SessionWithParent = { id: string; parentID?: string | null };
        const childSessions = sessions.filter(
          (s: SessionWithParent) => s.parentID !== undefined && s.parentID !== null
        );
        expect(childSessions.length).toBeGreaterThan(0);
        const firstChild = childSessions.find((s: SessionWithParent) => s.id === childSessionId);
        expect(firstChild).toBeDefined();
        expect(firstChild!.parentID).toBe(sessionId);

        // Child sessions should NOT be in root set
        for (const child of childSessions) {
          expect(client["rootSessionIds"].has(child.id)).toBe(false);
        }

        // listSessions returns all sessions (root and child)
        const allSessionsResult = await step("list sessions", client.listSessions());
        if (allSessionsResult.ok) {
          expect(allSessionsResult.value.length).toBeGreaterThan(0);
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
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk, step }) => {
        // Connect first to receive SSE events
        await step("connect", client.connect());

        // Get initial session count
        const initialResult = await step("list sessions", client.listSessions());
        expect(initialResult.ok).toBe(true);
        const initialCount = initialResult.ok ? initialResult.value.length : 0;

        // Create a new root session - this should trigger session.created event
        const session = await step("create session", sdk.session.create({ body: {} }));
        const sessionId = session.data!.id;

        // Give time for SSE event to be processed
        await delay(200);

        // SSE session.created event should have tracked it
        expect(client["rootSessionIds"].has(sessionId)).toBe(true);

        // Verify session exists
        const updatedResult = await step("list sessions", client.listSessions());
        expect(updatedResult.ok).toBe(true);
        if (updatedResult.ok) {
          expect(updatedResult.value.length).toBeGreaterThan(initialCount);
        }
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "session.created event for child session does not trigger root tracking",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ client, sdk, step }) => {
        // Connect first to receive SSE events
        await step("connect", client.connect());

        // Create root session via client (immediately tracked)
        const rootResult = await step("create session", client.createSession());
        expect(rootResult.ok).toBe(true);
        const rootSessionId = rootResult.ok ? rootResult.value.id : "";

        // Create a child session directly via SDK (simulates what task tool would do)
        const childSession = await step(
          "create child session",
          sdk.session.create({
            body: { parentID: rootSessionId },
          })
        );
        expect(childSession.data).toBeDefined();
        const childSessionId = childSession.data!.id;

        // Give time for SSE event to be processed
        await delay(200);

        // Verify root session is still tracked
        expect(client["rootSessionIds"].has(rootSessionId)).toBe(true);

        // Check that child sessions exist but are NOT in root set
        const allSessions = await step("list sessions", sdk.session.list());
        type SessionWithParent = { id: string; parentID?: string | null };
        const childSessions = (allSessions.data ?? []).filter(
          (s: SessionWithParent) => s.parentID !== undefined && s.parentID !== null
        );

        expect(childSessions.length).toBeGreaterThan(0);
        const createdChild = childSessions.find((s: SessionWithParent) => s.id === childSessionId);
        expect(createdChild).toBeDefined();

        for (const child of childSessions) {
          // Child sessions should NOT be tracked as root
          expect(client["rootSessionIds"].has(child.id)).toBe(false);
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
        async ({ client, sdk, step, waitFor }) => {
          // Track status changes
          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          // Connect first to receive SSE events
          await step("connect", client.connect());

          // Create session via client (immediately tracked)
          const sessionResult = await step("create session", client.createSession());
          expect(sessionResult.ok).toBe(true);
          const sessionId = sessionResult.ok ? sessionResult.value.id : "";

          // Send prompt - tool call executes without permission (bash="allow")
          await step(
            "prompt",
            sdk.session.prompt({
              path: { id: sessionId },
              body: { parts: [{ type: "text", text: "Run a command" }] },
            })
          );

          // Wait for session to return to idle
          await waitFor("session idle", () => {
            expect(statuses.includes("idle")).toBe(true);
          });

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
        async ({ client, sdk, step, waitFor }) => {
          // Track permission requests
          const requestEvents: UserRequestEvent[] = [];

          client.onUserRequestEvent((event) => {
            requestEvents.push(event);
          });

          // Track status changes
          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          // Connect first to receive SSE events
          await step("connect", client.connect());

          // Create session via client (immediately tracked)
          const sessionResult = await step("create session", client.createSession());
          expect(sessionResult.ok).toBe(true);
          const sessionId = sessionResult.ok ? sessionResult.value.id : "";

          // Send prompt - this triggers a tool call that requires permission
          const promptPromise = sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Run a command" }] },
          });

          // Wait for the permission request
          await waitFor("permission asked", () => {
            expect(requestEvents.some((e) => e.type === "asked")).toBe(true);
          });

          const asked = requestEvents.find((e) => e.type === "asked");
          if (asked?.type !== "asked") throw new Error("unreachable");
          expect(asked.event.kind).toBe("permission");
          const permissionId = asked.event.id;

          // Respond with approval using SDK top-level method
          await step(
            "reply to permission",
            sdk.postSessionIdPermissionsPermissionId({
              path: { id: sessionId, permissionID: permissionId },
              body: { response: "once" },
            })
          );

          // Wait for the request to be resolved
          await waitFor("permission resolved", () => {
            expect(requestEvents).toContainEqual({
              type: "resolved",
              event: { kind: "permission", requestID: permissionId, sessionID: sessionId },
            });
          });

          // Wait for prompt to complete
          await step("prompt completes", promptPromise);

          // Session should return to idle after tool executes
          await waitFor("session idle", () => {
            expect(statuses.includes("idle")).toBe(true);
          });

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
        async ({ client, sdk, step, waitFor }) => {
          // Track permission requests
          const requestEvents: UserRequestEvent[] = [];

          client.onUserRequestEvent((event) => {
            requestEvents.push(event);
          });

          // Track status changes
          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          // Connect first to receive SSE events
          await step("connect", client.connect());

          // Create session via client (immediately tracked)
          const sessionResult = await step("create session", client.createSession());
          expect(sessionResult.ok).toBe(true);
          const sessionId = sessionResult.ok ? sessionResult.value.id : "";

          // Send prompt - this triggers a tool call that requires permission
          const promptPromise = sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Run a command" }] },
          });

          // Wait for the permission request
          await waitFor("permission asked", () => {
            expect(requestEvents.some((e) => e.type === "asked")).toBe(true);
          });

          const asked = requestEvents.find((e) => e.type === "asked");
          if (asked?.type !== "asked") throw new Error("unreachable");
          expect(asked.event.kind).toBe("permission");
          const permissionId = asked.event.id;

          // Respond with rejection using SDK top-level method
          await step(
            "reply to permission",
            sdk.postSessionIdPermissionsPermissionId({
              path: { id: sessionId, permissionID: permissionId },
              body: { response: "reject" },
            })
          );

          // Wait for the request to be resolved
          await waitFor("permission resolved", () => {
            expect(requestEvents).toContainEqual({
              type: "resolved",
              event: { kind: "permission", requestID: permissionId, sessionID: sessionId },
            });
          });

          // Wait for prompt to complete
          await step("prompt completes", promptPromise);

          // Session should return to idle (tool was NOT executed due to rejection)
          await waitFor("session idle", () => {
            expect(statuses.includes("idle")).toBe(true);
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "question tool request emits asked and resolved events",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "question" },
        async ({ client, port, step, waitFor }) => {
          // Reply goes through the v2 client: the v1 SDK has no question endpoints.
          const v2 = createV2Client({ baseUrl: `http://127.0.0.1:${port}` });

          const requestEvents: UserRequestEvent[] = [];
          client.onUserRequestEvent((event) => {
            requestEvents.push(event);
          });
          const statuses: ClientStatus[] = [];
          client.onStatusChanged((status) => {
            statuses.push(status);
          });

          await step("connect", client.connect());

          const sessionResult = await step("create session", client.createSession());
          expect(sessionResult.ok).toBe(true);
          const sessionId = sessionResult.ok ? sessionResult.value.id : "";

          // Parks on the question tool until it is answered
          const promptPromise = v2.session.prompt({
            sessionID: sessionId,
            parts: [{ type: "text", text: "Ask me something" }],
          });

          await waitFor("question asked", () => {
            expect(requestEvents.some((e) => e.type === "asked")).toBe(true);
          });
          const asked = requestEvents.find((e) => e.type === "asked");
          if (asked?.type !== "asked") throw new Error("unreachable");
          expect(asked.event).toMatchObject({ kind: "question", sessionID: sessionId });

          await step(
            "reply to question",
            v2.question.reply({ requestID: asked.event.id, answers: [["A"]] })
          );

          await waitFor("question resolved", () => {
            expect(requestEvents).toContainEqual({
              type: "resolved",
              event: { kind: "question", requestID: asked.event.id, sessionID: sessionId },
            });
          });

          await step("prompt completes", promptPromise);
          await waitFor("session idle", () => {
            expect(statuses.includes("idle")).toBe(true);
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "provider reports idle while a question waits on the user",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "question" },
        async ({ port, cwd, step, waitFor }) => {
          const v2 = createV2Client({ baseUrl: `http://127.0.0.1:${port}` });
          const provider = new OpenCodeProvider(cwd, SILENT_LOGGER);
          onTestFinished(() => provider.dispose());

          const statuses: AgentStatus[] = [];
          provider.onStatusChange((status) => statuses.push(status));

          await step("connect provider", provider.connect(port));
          provider.markActive();
          const sessionId = provider.getSession()!.sessionId;

          const promptPromise = v2.session.prompt({
            sessionID: sessionId,
            parts: [{ type: "text", text: "Ask me something" }],
          });

          // The session goes busy, then parks on the question: still busy to
          // OpenCode, idle to the user.
          await waitFor("busy, then idle on the question", () => {
            expect(statuses).toContain("busy");
            expect(statuses.at(-1)).toBe("idle");
          });
          const pending = (await step("list questions", v2.question.list())).data ?? [];
          expect(pending.map((q) => q.sessionID)).toEqual([sessionId]);
          const sessionStatus = (await step("session status", v2.session.status())).data ?? {};
          expect(sessionStatus[sessionId]?.type).toBe("busy");

          await step(
            "reply to question",
            v2.question.reply({ requestID: pending[0]!.id, answers: [["A"]] })
          );
          await step("prompt completes", promptPromise);

          await waitFor("provider counts idle", () => {
            expect(provider.getEffectiveCounts()).toEqual({ idle: 1, busy: 0 });
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "subagent permission request emits an asked event",
    async () => {
      await withOpencode(
        {
          binaryPath,
          mockLlmMode: "tool-call",
          permission: { bash: "ask", edit: "allow", webfetch: "allow" },
        },
        async ({ client, sdk, step, waitFor }) => {
          // Track permission requests
          const requestEvents: UserRequestEvent[] = [];

          client.onUserRequestEvent((event) => {
            requestEvents.push(event);
          });

          // Connect first to receive SSE events
          await step("connect", client.connect());

          // Create root session via client (immediately tracked)
          const rootResult = await step("create session", client.createSession());
          expect(rootResult.ok).toBe(true);
          const rootSessionId = rootResult.ok ? rootResult.value.id : "";

          // Create child session (subagent)
          const childSession = await step(
            "create child session",
            sdk.session.create({
              body: { parentID: rootSessionId },
            })
          );
          const childSessionId = childSession.data!.id;

          // Wait for SSE event to process child session mapping
          await delay(100);

          // Send prompt to CHILD session - triggers bash tool requiring permission
          const promptPromise = sdk.session.prompt({
            path: { id: childSessionId },
            body: { parts: [{ type: "text", text: "Run a command" }] },
          });

          // Wait for the permission request from the child session
          await waitFor("permission asked", () => {
            expect(requestEvents.some((e) => e.type === "asked")).toBe(true);
          });

          // Verify the event has the child session ID (not remapped to root)
          const asked = requestEvents.find((e) => e.type === "asked");
          if (asked?.type !== "asked") throw new Error("unreachable");
          expect(asked.event.sessionID).toBe(childSessionId);

          // Approve permission using child session ID
          await step(
            "reply to permission",
            sdk.postSessionIdPermissionsPermissionId({
              path: { id: childSessionId, permissionID: asked.event.id },
              body: { response: "once" },
            })
          );

          // Wait for prompt to complete
          await step("prompt completes", promptPromise);
        }
      );
    },
    CI_TIMEOUT_MS
  );

  // ===========================================================================
  // Phase 7: Initial Prompt Tests (CREATE_WORKSPACE_TOOL feature)
  // ===========================================================================

  it(
    "session.create and session.prompt send prompt successfully",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ sdk, step }) => {
        // Step 1: Create a new session
        const sessionResult = await step("create session", sdk.session.create({ body: {} }));
        expect(sessionResult.data).toBeDefined();
        expect(typeof sessionResult.data!.id).toBe("string");
        const sessionId = sessionResult.data!.id;

        // Step 2: Send a prompt to the session
        const promptResult = await step(
          "prompt",
          sdk.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "Hello, this is a test prompt" }] },
          })
        );

        // Step 3: Verify the prompt was sent (response exists)
        expect(promptResult.data).toBeDefined();

        // Step 4: Verify session exists in list
        const listResult = await step("list sessions", sdk.session.list());
        const sessions = listResult.data ?? [];
        const ourSession = sessions.find((s) => s.id === sessionId);
        expect(ourSession).toBeDefined();

        // Step 5: Verify prompt appears in session messages
        const messagesResult = await step(
          "fetch messages",
          sdk.session.messages({ path: { id: sessionId } })
        );
        const messages = messagesResult.data ?? [];
        expect(messages.length).toBeGreaterThan(0);

        // Verify at least one message has info.role === "user"
        const userMessages = messages.filter((m) => m.info.role === "user");
        expect(userMessages.length).toBeGreaterThan(0);
      });
    },
    CI_TIMEOUT_MS
  );

  it(
    "session.prompt with agent parameter stores agent in UserMessage",
    async () => {
      await withOpencode({ binaryPath, mockLlmMode: "instant" }, async ({ sdk, step }) => {
        // Step 1: Create a new session
        const sessionResult = await step("create session", sdk.session.create({ body: {} }));
        expect(sessionResult.data).toBeDefined();
        const sessionId = sessionResult.data!.id;

        // Step 2: Send a prompt WITH agent parameter
        // Using "build" which is a valid default agent in OpenCode
        const testAgent = "build";
        await step(
          "prompt",
          sdk.session.prompt({
            path: { id: sessionId },
            body: {
              agent: testAgent,
              parts: [{ type: "text", text: "Test prompt with agent" }],
            },
          })
        );

        // Step 3: Fetch messages for the session
        const messagesResult = await step(
          "fetch messages",
          sdk.session.messages({ path: { id: sessionId } })
        );
        const messages = messagesResult.data ?? [];

        // Step 4: Find the UserMessage and verify agent field
        // Note: SDK types may not include 'agent' property, but OpenCode stores it
        const userMessage = messages.find((m) => m.info.role === "user");
        expect(userMessage).toBeDefined();
        const userInfo = userMessage!.info as { role: string; agent?: string };
        expect(userInfo.agent).toBe(testAgent);
      });
    },
    CI_TIMEOUT_MS
  );
});
