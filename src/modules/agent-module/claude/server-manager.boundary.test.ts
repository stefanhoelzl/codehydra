// @vitest-environment node
/**
 * Boundary tests for ClaudeCodeServerManager against a REAL `claude`.
 *
 * `server-manager.integration.test.ts` covers how the manager REACTS to hook
 * payloads — thoroughly, and with payloads we hand it ourselves. What nothing
 * covered until now is the premise underneath all of it: that Claude Code still
 * emits those hooks, with those payloads, in that order. That premise is a pile
 * of empirical findings ("verified against Claude Code 2.1.202") which a Claude
 * release can invalidate without a single test going red.
 *
 * So these tests spawn the real binary against a mock model and assert the
 * `AgentStatus` that comes out the far end of the shipped chain. They are
 * additive: nothing in the synthetic suite is retired, because a synthetic
 * failure says *our logic* broke while a failure here says *Claude* changed.
 *
 * **They assert status, never hook names or payload fields.** That is
 * deliberate, and it is still enough: rename `background_tasks` and the
 * running-shell `Stop` stops being suppressed, so "stays busy" fails. The
 * status is the drift detector, and a hook Claude adds that changes nothing
 * passes silently, as it should.
 *
 * Requires a real `claude` on PATH and `pnpm build:wrappers` — both fail loudly
 * rather than skipping, so the coverage cannot be lost by accident.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { chBgPathEntry, runScenario, seen, type ScenarioRun } from "./boundary-test-utils";

/** A whole scenario is ~0.7s; the slowest (a background shell's full life) ~3s. */
const SCENARIO_TIMEOUT_MS = 90_000;

describe("a plain turn", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    run = await runScenario("plain", {
      until: (r) => seen(r, "Stop"),
      thenEndSession: true,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("SessionStart leaves the workspace idle", () => {
    expect(run.statusAfter("SessionStart")).toBe("idle");
  });

  it("UserPromptSubmit makes it busy", () => {
    expect(run.statusAfter("UserPromptSubmit")).toBe("busy");
  });

  it("Stop returns it to idle", () => {
    expect(run.statusAfter("Stop")).toBe("idle");
  });

  it("SessionEnd leaves no agent", () => {
    expect(run.statusAfter("SessionEnd")).toBe("none");
  });
});

describe("a turn that uses a tool", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    run = await runScenario("tool", { until: (r) => seen(r, "Stop") });
  }, SCENARIO_TIMEOUT_MS);

  it("PreToolUse mid-turn does not change the status", () => {
    // The "PreToolUse while idle -> busy" rule exists for turns we never saw
    // start; a tool inside a turn already known to be running must be a no-op.
    expect(run.statusAcross("PreToolUse")).toEqual({ before: "busy", after: "busy" });
  });

  it("PostToolUse keeps it busy", () => {
    expect(run.statusAfter("PostToolUse")).toBe("busy");
  });

  it("the turn still ends idle", () => {
    expect(run.statusAfter("Stop")).toBe("idle");
  });
});

describe("a background shell, over its whole life", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    // Two Stops: the one suppressed while the shell runs, and the one after it
    // exits. The second only exists because Claude re-invokes the agent when a
    // background task finishes.
    run = await runScenario("bgcomplete", { until: (r) => seen(r, "Stop", 2) });
  }, SCENARIO_TIMEOUT_MS);

  it("the Stop that lands while the shell is running stays busy", () => {
    expect(run.statusAcross("Stop", 0)).toEqual({ before: "busy", after: "busy" });
  });

  it("Claude re-invokes the agent once the shell exits", () => {
    // The re-invoke is a real UserPromptSubmit, and it is what clears the
    // suppression stash so the next Stop can decide from fresh ground truth.
    expect(run.count("UserPromptSubmit")).toBeGreaterThanOrEqual(2);
    expect(run.statusAfter("UserPromptSubmit", 1)).toBe("busy");
  });

  it("the Stop after the shell has exited goes idle", () => {
    expect(run.statusAfter("Stop", 1)).toBe("idle");
  });
});

describe("a background shell wrapped in ch-bg", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    // `resources/bin` on PATH so the shell genuinely starts and is reported as
    // running. Without it the shell dies instantly, background_tasks is empty,
    // and this would go idle for the wrong reason and still pass.
    run = await runScenario("chbg", {
      until: (r) => seen(r, "Stop"),
      pathPrefix: [chBgPathEntry()],
    });
  }, SCENARIO_TIMEOUT_MS);

  it("goes idle even though the shell is still running", () => {
    expect(run.statusAfter("Stop")).toBe("idle");
  });
});

describe("a turn that spawns a sub-agent", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    run = await runScenario("subagent", { until: (r) => seen(r, "Stop") });
  }, SCENARIO_TIMEOUT_MS);

  it("SubagentStart does not drive the workspace status", () => {
    const { before, after } = run.statusAcross("SubagentStart");
    expect(after).toBe(before);
  });

  it("SubagentStop does not drive the workspace status", () => {
    // Ignored because HOOK_SPEC maps SubagentStop to no status change — NOT by
    // the `agent_id` guard on Stop/StopFailure. Real Claude ends a sub-agent's
    // turn with SubagentStop, never with a Stop carrying an agent_id, so that
    // guard is unreachable from here and stays covered synthetically.
    const { before, after } = run.statusAcross("SubagentStop");
    expect(after).toBe(before);
  });

  it("the main Stop stays busy while the sub-agent is still running", () => {
    expect(run.statusAcross("Stop", 0)).toEqual({ before: "busy", after: "busy" });
  });
});

describe("a turn that dies on max_tokens", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    run = await runScenario("maxtokens", { until: (r) => seen(r, "StopFailure") });
  }, SCENARIO_TIMEOUT_MS);

  it("StopFailure surfaces the stuck agent as idle", () => {
    expect(run.statusAfter("StopFailure")).toBe("idle");
  });
});
