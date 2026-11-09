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
 * `AgentActivity` that comes out the far end of the shipped chain. They are
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
import {
  chBgPathEntry,
  runScenario,
  seen,
  type HookRecord,
  type ScenarioRun,
} from "./boundary-test-utils";

/** A whole scenario is ~0.7s; the slowest (a background workflow's full life) ~7s. */
const SCENARIO_TIMEOUT_MS = 90_000;

/**
 * How long after the prompt-suggestion fork's request to wait for its hook. Up
 * to 2.1.319 it lands within a second; from 2.1.321 there is none to wait for.
 */
const FORK_HOOK_GRACE_MS = 1_500;

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
    // Wait for BOTH, because the main `Stop` does not imply `SubagentStop` —
    // the third assertion below is precisely that the main turn ends while the
    // sub-agent is still running, so `SubagentStop` lands afterwards. Waiting on
    // `Stop` alone raced it: the poll returned and the agent was killed with the
    // sub-agent's hook still in flight, which is a separate process and so is
    // slowest exactly where this failed, on Windows. That the sub-agent is still
    // running at the main Stop is made certain by the fixture (a sleep before it
    // answers), not left to which of two instant mock replies lands first.
    run = await runScenario("subagent", {
      until: (r) => seen(r, "Stop") && seen(r, "SubagentStop"),
    });
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

describe("a background workflow, over its whole life", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    // Two main-agent Stops: one while the workflow's agent still sleeps, and
    // one after the wake-up Claude sends when the workflow finishes.
    run = await runScenario("workflow", { until: (r) => seen(r, "Stop", 2) });
  }, SCENARIO_TIMEOUT_MS);

  it("the Stop that lands while the workflow runs stays busy", () => {
    expect(run.statusAcross("Stop", 0)).toEqual({ before: "busy", after: "busy" });
  });

  it("the Stop after the workflow has finished goes idle", () => {
    expect(run.statusAfter("Stop", 1)).toBe("idle");
  });
});

describe("a [bg] workflow whose agent runs a background shell", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    // The fixture lands the main Stop while the shell runs beside the workflow.
    run = await runScenario("bgworkflowshell", { until: (r) => seen(r, "Stop") });
  }, SCENARIO_TIMEOUT_MS);

  it("goes idle beside the workflow and its agent's shell", () => {
    expect(run.statusAfter("Stop", 0)).toBe("idle");
  });
});

describe("a [bg] sub-agent's background shell", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    // Two main-agent Stops: one beside the running sub-agent, and one after the
    // wake-up its end sends, when only its shell is left.
    run = await runScenario("bgsubagentshell", { until: (r) => seen(r, "Stop", 2) });
  }, SCENARIO_TIMEOUT_MS);

  it("goes idle beside the [bg] sub-agent", () => {
    expect(run.statusAfter("Stop", 0)).toBe("idle");
  });

  it("stays idle once only the sub-agent's shell is left", () => {
    expect(run.statusAfter("Stop", 1)).toBe("idle");
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

describe("a prompt-suggestion fork while a background sub-agent runs (TUI)", () => {
  // The report: an agent ended its turn waiting on two background research
  // agents; the hidden fork that guesses the user's next prompt answered with
  // an AskUserQuestion; its PreToolUse reached the bridge as the agent's own,
  // parked the workspace idle, and — no Post hook ever following the denied
  // call — every busy signal from the still-working sub-agents was swallowed.
  // The fork only runs in the interactive TUI, hence the mode.
  //
  // The fork's PreToolUse is not a signal the status needs — it is noise the
  // bridge must ignore — and since 2.1.321 Claude no longer sends it. So the
  // scenario waits for the fork to RUN (its request reaching the mock), not
  // for its hook; when the hook does come (2.1.319 and earlier) it is checked.
  let run: ScenarioRun;
  const isForkAsk = (record: HookRecord): boolean =>
    record.hook === "PreToolUse" && record.toolName === "AskUserQuestion";
  beforeAll(async () => {
    // The main Stop and the fork, in either order: the fork starts the moment
    // the turn ends, so its PreToolUse can reach the bridge before the Stop
    // that preceded it. Once the fork has asked the model, give its hook (if
    // this Claude sends one) a moment to land — well inside the sub-agent's 5s.
    run = await runScenario("suggestionfork", {
      mode: "tui",
      until: (r, progress) =>
        seen(r, "Stop") &&
        (r.some(isForkAsk) || (progress.suggestionForkAgeMs ?? 0) > FORK_HOOK_GRACE_MS),
    });
  }, SCENARIO_TIMEOUT_MS);

  it("the main Stop does not end the busy state while the sub-agent runs", () => {
    // Not "busy before and after": if the fork's hook overtook it, the Stop
    // lands on whatever the fork left. What it must never do is flip busy to
    // idle itself.
    const { before, after } = run.statusAcross("Stop", 0);
    expect(after).toBe(before);
  });

  it("the fork's AskUserQuestion, if Claude sends it, does not park the workspace", () => {
    const parked = run.records.filter((record) => isForkAsk(record) && record.after !== "busy");
    expect(parked).toEqual([]);
  });

  it("the workspace is still busy once both have landed", () => {
    expect(run.finalStatus).toBe("busy");
  });
});

describe("a message from outside, to a session that prompts for permissions", () => {
  const message = { text: "MESSAGE-PROBE the build is green", from: "CodeHydra · workspace probe" };
  let run: ScenarioRun;
  beforeAll(async () => {
    // Pins the undocumented part of Claude's inbox: the JSON line format, and
    // the sender envelope it parses. The docs call the format plain text.
    run = await runScenario("message", {
      until: (r) => seen(r, "Stop"),
      permissionMode: "default",
      message,
      afterMessageUntil: (r) => seen(r, "Stop", 2),
    });
  }, SCENARIO_TIMEOUT_MS);

  it("reaches the model", () => {
    expect(run.deliveredMessage).toContain(message.text);
  });

  it("starts a turn that reads busy, and ends it idle", () => {
    // A workspace woken for a message reads busy until the agent's turn on it
    // starts, and from then on the agent's own status tells: so that turn must
    // read busy before its Stop, or the workspace would sit busy for 30s more.
    const afterFirstStop = run.records.slice(
      run.records.findIndex((record) => record.hook === "Stop") + 1
    );
    expect(afterFirstStop.some((record) => record.after === "busy")).toBe(true);
    expect(run.statusAfter("Stop", 1)).toBe("idle");
  });

  it("names its sender in the envelope Claude parses", () => {
    expect(run.deliveredMessage).toContain(
      `<cross-session-message from-name="${message.from}">\n${message.text}\n</cross-session-message>`
    );
  });
});

describe("a message from outside, to a session that bypasses permission prompts", () => {
  let run: ScenarioRun;
  beforeAll(async () => {
    // CodeHydra declares no permission mode for itself. On macOS and Linux
    // Claude verifies a sender by its process tree, finds CodeHydra is not its
    // child, and — running tools without asking — holds the message for its
    // user, who is not here. On Windows it verifies by the token instead, which
    // the auth line must carry there, so the message counts as the session's
    // own and is delivered.
    run = await runScenario("message", {
      until: (r) => seen(r, "Stop"),
      permissionMode: "bypassPermissions",
      message: { text: "MESSAGE-PROBE held", from: "CodeHydra · workspace probe" },
      messageWaitMs: 5_000,
    });
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(process.platform === "win32")("is held back from the model (macOS, Linux)", () => {
    expect(run.deliveredMessage).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("is delivered all the same (Windows)", () => {
    expect(run.deliveredMessage).toContain("MESSAGE-PROBE held");
  });
});
