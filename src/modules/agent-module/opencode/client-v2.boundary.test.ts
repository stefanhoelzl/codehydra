// @vitest-environment node
/**
 * Boundary tests for OpenCodeClient on the 2.x wire.
 *
 * Runs against a real OpenCode 2 serve process with a mock LLM, through the
 * same harness as the 1.x suite (boundary-test-utils.ts) with
 * `major: 2`. Pins what differs from 1.x:
 * - busy/idle arrives as the execution lifecycle, not `session.status`
 * - a turn's completion is prompt + `wait`
 * - permissions are replied through `permission.reply`
 * - v1's `question` tool is forms, created and answered over the API
 *
 * @group boundary
 */

import { describe, it, expect, beforeAll } from "vitest";
import { OpenCodeClient } from "./client";
import { withOpencode, type OpencodeTestContext } from "./boundary-test-utils";
import { CI_TIMEOUT_MS } from "../../../boundaries/platform/network.test-utils";
import {
  ensureBinaryForTests,
  getBinaryPathForTests,
  warmBinaryForTests,
  BINARY_WARM_TIMEOUT_MS,
} from "../../../utils/testing/ensure-binaries";
import type { ClientStatus } from "./types";
import type { UserRequestEvent } from "./client";

// =============================================================================
// Helpers (mirrors of the 1.x suite's)
// =============================================================================

type AskedEvent = Extract<UserRequestEvent, { type: "asked" }>;

/** Every status the client reports, in order. */
function recordStatuses(client: OpenCodeClient): ClientStatus[] {
  const statuses: ClientStatus[] = [];
  client.onStatusChanged((status) => {
    statuses.push(status);
  });
  return statuses;
}

/** Every user-request event the client emits, in order. */
function recordUserRequests(client: OpenCodeClient): UserRequestEvent[] {
  const requestEvents: UserRequestEvent[] = [];
  client.onUserRequestEvent((event) => {
    requestEvents.push(event);
  });
  return requestEvents;
}

/** Create a root session via the client (immediately tracked) and return its id. */
async function createTrackedSession(
  client: OpenCodeClient,
  step: OpencodeTestContext["step"]
): Promise<string> {
  const sessionResult = await step("create session", client.createSession());
  expect(sessionResult.ok).toBe(true);
  return sessionResult.ok ? sessionResult.value.id : "";
}

/** The first `asked` event, once one has arrived. */
async function waitForAsked(
  waitFor: OpencodeTestContext["waitFor"],
  requestEvents: readonly UserRequestEvent[],
  label: string
): Promise<AskedEvent> {
  await waitFor(label, () => {
    expect(requestEvents.some((e) => e.type === "asked")).toBe(true);
  });
  const asked = requestEvents.find((e) => e.type === "asked");
  if (asked?.type !== "asked") throw new Error("unreachable");
  return asked;
}

describe("OpenCodeClient boundary tests (2.x wire)", () => {
  let binaryPath: string;

  beforeAll(async () => {
    await ensureBinaryForTests("opencode", { opencodeMajor: 2 });
    binaryPath = getBinaryPathForTests("opencode", { opencodeMajor: 2 });
    await warmBinaryForTests("opencode", { opencodeMajor: 2 });
  }, BINARY_WARM_TIMEOUT_MS);

  it(
    "lists and creates sessions at the workspace location",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "instant", major: 2 },
        async ({ client, v2, cwd, step }) => {
          const sessionResult = await step("create session", client.createSession());
          expect(sessionResult.ok).toBe(true);
          if (!sessionResult.ok) return;
          const sessionId = sessionResult.value.id;

          // The client's listing is scoped to the workspace directory and to
          // root sessions; the created session is both.
          const sessions = await step("list sessions", client.listSessions());
          expect(sessions.ok).toBe(true);
          if (!sessions.ok) return;
          expect(sessions.value.some((s) => s.id === sessionId)).toBe(true);
          for (const session of sessions.value) {
            expect(session.directory).toBe(cwd);
          }

          // The raw client sees the same session through the API.
          const fetched = await step("get session", v2.session.get({ sessionID: sessionId }));
          expect(fetched.id).toBe(sessionId);
          expect(fetched.location.directory).toBe(cwd);
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "reports busy and idle from the execution lifecycle of a turn",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "instant", major: 2 },
        async ({ client, v2, step, waitFor }) => {
          const statuses = recordStatuses(client);
          await step("connect", client.connect());
          const sessionId = await createTrackedSession(client, step);

          // Initial aggregate: nothing running.
          expect(await client.getStatus()).toEqual({ ok: true, value: "idle" });

          await step("prompt", v2.session.prompt({ sessionID: sessionId, text: "Say hello" }));

          await waitFor("busy during the turn", () => {
            expect(statuses).toContain("busy");
          });
          await waitFor("idle after the turn", () => {
            expect(statuses[statuses.length - 1]).toBe("idle");
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "sendPrompt resolves when the turn it started has finished",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "instant", major: 2 },
        async ({ client, mockLlm, step }) => {
          await step("connect", client.connect());
          const sessionId = await createTrackedSession(client, step);

          const before = mockLlm.requests().length;
          // The 2.x prompt resolves on admission; the client waits for the
          // loop to go idle on top of it.
          await step("sendPrompt", client.sendPrompt(sessionId, "Say hello"));

          // The turn ran and finished while sendPrompt was outstanding.
          expect(mockLlm.requests().length).toBeGreaterThan(before);
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "sendPromptAsync queues without waiting for the turn",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "instant", major: 2 },
        async ({ client, mockLlm, step }) => {
          await step("connect", client.connect());
          const sessionId = await createTrackedSession(client, step);

          const before = mockLlm.requests().length;
          // Resolves as soon as the server accepted it — the turn may still
          // be running — and the queued prompt still gets served.
          await step("queue prompt", client.sendPromptAsync(sessionId, "Say hello"));
          await waitForRequestServed(mockLlm, before);
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "reports a permission ask and its resolution",
    async () => {
      await withOpencode(
        {
          binaryPath,
          mockLlmMode: "tool-call",
          major: 2,
          permission: { bash: "ask", edit: "allow", webfetch: "allow" },
        },
        async ({ client, v2, step, waitFor }) => {
          const requestEvents = recordUserRequests(client);
          const statuses = recordStatuses(client);

          await step("connect", client.connect());
          const sessionId = await createTrackedSession(client, step);

          await step("prompt", v2.session.prompt({ sessionID: sessionId, text: "Run a command" }));

          const asked = await waitForAsked(waitFor, requestEvents, "permission asked");
          expect(asked.event.kind).toBe("permission");
          const requestId = asked.event.id;

          await step(
            "reply to permission",
            v2.permission.reply({ sessionID: sessionId, requestID: requestId, decision: "once" })
          );

          await waitFor("permission resolved", () => {
            expect(requestEvents).toContainEqual({
              type: "resolved",
              event: { kind: "permission", requestID: requestId, sessionID: sessionId },
            });
          });
          await waitFor("session idle again", () => {
            expect(statuses[statuses.length - 1]).toBe("idle");
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "reports a form (2.x's question) and its answer",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "instant", major: 2 },
        async ({ client, v2, step, waitFor }) => {
          const requestEvents = recordUserRequests(client);

          await step("connect", client.connect());
          const sessionId = await createTrackedSession(client, step);

          // A form is what the `question` tool became: created over the API
          // (the tool does the same server-side), answered the same way.
          const form = await step(
            "create form",
            v2.session.form.create({
              sessionID: sessionId,
              title: "Pick one",
              fields: [{ key: "choice", type: "string", title: "Which?" }],
            })
          );

          const asked = await waitForAsked(waitFor, requestEvents, "form asked");
          expect(asked.event.kind).toBe("form");
          expect(asked.event.id).toBe(form.id);

          await step(
            "reply to form",
            v2.session.form.reply({
              sessionID: sessionId,
              formID: form.id,
              answer: { choice: "A" },
            })
          );

          await waitFor("form resolved", () => {
            expect(requestEvents).toContainEqual({
              type: "resolved",
              event: { kind: "form", requestID: form.id, sessionID: sessionId },
            });
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "maps a rate-limited turn's retry to busy",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "rate-limit", major: 2 },
        async ({ client, v2, step, waitFor }) => {
          const statuses = recordStatuses(client);
          await step("connect", client.connect());
          const sessionId = await createTrackedSession(client, step);

          await step("prompt", v2.session.prompt({ sessionID: sessionId, text: "Say hello" }));

          // The rate limit schedules retries; a retrying session is busy.
          await waitFor("busy through retries", () => {
            expect(statuses).toContain("busy");
          });
          await waitFor("idle after recovery", () => {
            expect(statuses[statuses.length - 1]).toBe("idle");
          });
        }
      );
    },
    CI_TIMEOUT_MS
  );

  it(
    "tracks a subagent session without emitting its events as the root's",
    async () => {
      await withOpencode(
        { binaryPath, mockLlmMode: "instant", major: 2 },
        async ({ client, v2, cwd, step, waitFor }) => {
          const requestEvents = recordUserRequests(client);
          const sessionEvents: Array<{ type: string; sessionId: string }> = [];
          client.onSessionEvent((event) => sessionEvents.push(event));

          await step("connect", client.connect());
          const rootId = await createTrackedSession(client, step);

          // A child session (what a subagent runs in), created server-side.
          const child = await step(
            "create child session",
            v2.session.create({ parentID: rootId, location: { directory: cwd } })
          );

          // The child's creation routes it under its root: a form asked in the
          // child surfaces as a user request (that is what the mapping is for).
          const form = await step(
            "create form in child",
            v2.session.form.create({
              sessionID: child.id,
              title: "Pick one",
              fields: [{ key: "choice", type: "string", title: "Which?" }],
            })
          );
          const asked = await waitForAsked(waitFor, requestEvents, "form asked in child");
          expect(asked.event.sessionID).toBe(child.id);
          expect(asked.event.id).toBe(form.id);

          // The root's own turn still emits as its own.
          await step("prompt root", v2.session.prompt({ sessionID: rootId, text: "Say hello" }));
          await waitFor("root busy", () => {
            expect(sessionEvents.some((e) => e.sessionId === rootId && e.type === "busy")).toBe(
              true
            );
          });
          // And the child's lifecycle never emitted as the root's.
          expect(sessionEvents.some((e) => e.sessionId === child.id)).toBe(false);
        }
      );
    },
    CI_TIMEOUT_MS
  );
});

/** Wait until the mock LLM has served one more request than `before`. */
async function waitForRequestServed(mockLlm: { requests(): readonly unknown[] }, before: number) {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (mockLlm.requests().length > before) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10_000) {
        clearInterval(timer);
        reject(new Error("the queued prompt was never served"));
      }
    }, 100);
  });
}
