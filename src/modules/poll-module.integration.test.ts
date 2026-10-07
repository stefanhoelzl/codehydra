// @vitest-environment node
/**
 * Integration tests for the poll module through the dispatcher: its timer, the
 * `poll:tick` pipeline (collect → run → result → report) and the failures it
 * announces for every owner.
 *
 * A test owner module collects jobs and records what reaches its "result"
 * hook; a fake script runner answers each script with the outcome the test set
 * for it and records the run logs written.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createMockDispatcher } from "../intents/lib/dispatcher.test-utils";
import { createMockConfig } from "../boundaries/platform/config.test-utils";
import { createBehavioralLogger } from "../boundaries/platform/logging.test-utils";
import { createMockNotificationManager } from "./presentation/notification-manager.state-mock";
import type { IntentModule } from "../intents/lib/module";
import { defineHooks } from "../intents/declarations";
import { EVENT_APP_STARTED } from "../intents/app-ready";
import {
  AppShutdownOperation,
  INTENT_APP_SHUTDOWN,
  type AppShutdownIntent,
} from "../intents/app-shutdown";
import {
  POLL_TICK_OPERATION_ID,
  PollTickOperation,
  type PollJob,
  type PollRun,
} from "../intents/poll-tick";
import { createPollModule } from "./poll-module";
import type { RunJudgement, ScriptRequest, ScriptRunner } from "./scripts/script-runner";
import { ShellUnavailableError } from "./scripts/shells";
import { Path } from "../utils/path/path";
import { testPath } from "../shared/test-fixtures";

const MINUTE = 60_000;

interface Outcome {
  readonly exitCode?: number;
  readonly stdout?: string;
  /** The shell is not installed. */
  readonly unavailable?: boolean;
}

function job(id: string, overrides: Partial<PollJob> = {}): PollJob {
  return {
    owner: "test",
    id,
    source: "local:test",
    entry: `automations.${id}`,
    shell: "bash",
    script: id,
    cwd: testPath("/plugins").toString(),
    input: {},
    logDir: testPath(`/logs/${id}`).toString(),
    failure: { title: "Test failed", pointer: "see the test" },
    ...overrides,
  };
}

function createSetup(options?: { config?: Record<string, unknown> }) {
  const dispatcher = createMockDispatcher();
  const cards = createMockNotificationManager();
  cards.register(dispatcher);
  const config = createMockConfig({ defaults: options?.config ?? {} });

  /** Each script's outcome, by script body. */
  const outcomes: Record<string, Outcome> = {};
  const requests: ScriptRequest[] = [];
  const logs: Array<{ entry: string } & RunJudgement> = [];
  /** Set to hold every run open (a slow tick). */
  let gate: Promise<void> | null = null;

  const runner: ScriptRunner = {
    async run(request) {
      requests.push(request);
      const outcome = outcomes[request.script] ?? {};
      if (outcome.unavailable) {
        throw new ShellUnavailableError(request.shell, `${request.shell} is not installed`);
      }
      if (gate) await gate;
      const canceled = request.signal?.aborted ?? false;
      return {
        result: canceled
          ? { status: "canceled", exitCode: null, stdout: "", stderr: "" }
          : {
              status: "exited",
              exitCode: outcome.exitCode ?? 0,
              stdout: outcome.stdout ?? "",
              stderr: "",
            },
        finish: async (judgement) => {
          logs.push({ entry: request.entry, ...judgement });
          return new Path(request.logDir, `${logs.length}.log`);
        },
      };
    },
  };

  /** The jobs the test owner collects each tick. */
  let jobs: PollJob[] = [];
  /** What reached the owner's result hook, in order. */
  const results: Array<{ id: string; run: PollRun }> = [];
  /** Errors the owner returns for a job, by id. */
  const ownerErrors: Record<string, string[]> = {};
  const owner: IntentModule = {
    name: "test-owner",
    hooks: defineHooks({
      [POLL_TICK_OPERATION_ID]: {
        collect: { handler: async () => ({ result: { jobs } }) },
        result: {
          handler: async (ctx) => {
            if (ctx.job.owner !== "test") return;
            results.push({ id: ctx.job.id, run: ctx.run });
            return { result: { errors: ownerErrors[ctx.job.id] ?? [] } };
          },
        },
      },
    }),
  };

  const poll = createPollModule({
    dispatcher,
    config,
    logger: createBehavioralLogger(),
    runner,
  });
  dispatcher.registerOperation(new PollTickOperation());
  dispatcher.registerOperation(new AppShutdownOperation());
  dispatcher.registerModule(poll);
  dispatcher.registerModule(owner);

  return {
    dispatcher,
    poll,
    config,
    outcomes,
    requests,
    logs,
    results,
    ownerErrors,
    setJobs: (next: PollJob[]): void => {
      jobs = next;
    },
    hold: (): (() => void) => {
      let release = (): void => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    get cards() {
      return cards.notifications.map((card) => card.opened);
    },
    settle: () => cards.settle(),
    start: async (): Promise<void> => {
      await poll.events![EVENT_APP_STARTED]!.handler({ type: EVENT_APP_STARTED, payload: {} });
    },
  };
}

const shutdownIntent: AppShutdownIntent = {
  type: INTENT_APP_SHUTDOWN,
  payload: {} as AppShutdownIntent["payload"],
};

beforeEach(() => {
  // setImmediate stays real: the notification mock settles on it.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("poll module: ticks", () => {
  it("runs every collected job on app start and hands each run to its owner", async () => {
    const setup = createSetup();
    setup.setJobs([job("a"), job("b")]);
    setup.outcomes["a"] = { stdout: "[1]" };

    await setup.start();

    expect(setup.results.map((r) => [r.id, r.run.stdout])).toEqual(
      expect.arrayContaining([
        ["a", "[1]"],
        ["b", ""],
      ])
    );
    expect(setup.logs.map((log) => log.outcome)).toEqual(["ok", "ok"]);
    expect(setup.poll.errors()).toEqual([]);
  });

  it("passes the job's script, cwd, environment and paths to the runner", async () => {
    const setup = createSetup();
    setup.setJobs([
      job("a", {
        env: { TOKEN: "x" },
        workspaceDir: testPath("/ws").toString(),
        pluginDir: testPath("/plugins/a").toString(),
      }),
    ]);

    await setup.start();

    const request = setup.requests[0]!;
    expect(request.env).toEqual({ TOKEN: "x" });
    expect(request.cwd.equals(new Path(testPath("/plugins")))).toBe(true);
    expect(request.workspaceDir?.equals(new Path(testPath("/ws")))).toBe(true);
    expect(request.pluginDir?.equals(new Path(testPath("/plugins/a")))).toBe(true);
  });

  it("kills a run after poll.timeout, unless the job sets its own", async () => {
    const setup = createSetup({ config: { "poll.timeout": 5 } });
    setup.setJobs([job("a"), job("b", { timeoutMs: 1_000 })]);

    await setup.start();

    expect(setup.requests.map((r) => r.timeoutMs)).toEqual([5_000, 1_000]);
  });

  it("waits poll.interval after a tick before the next", async () => {
    const setup = createSetup({ config: { "poll.interval": 10 } });
    setup.setJobs([job("a")]);
    await setup.start();
    expect(setup.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(setup.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setup.requests).toHaveLength(2);
  });

  it("picks up a changed interval once the current wait has elapsed", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    await setup.start();

    await setup.config.set("poll.interval", 10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(setup.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MINUTE - 10_000);
    expect(setup.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(setup.requests).toHaveLength(3);
  });

  it("waits a full interval after a slow tick ends, without stacking ticks", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    await setup.start();

    const release = setup.hold();
    await vi.advanceTimersByTimeAsync(MINUTE); // tick 2 starts and blocks
    expect(setup.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(setup.requests).toHaveLength(2);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(setup.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(setup.requests).toHaveLength(3);
  });

  it("stops ticking on shutdown", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    await setup.start();
    await setup.dispatcher.dispatch(shutdownIntent);

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(setup.requests).toHaveLength(1);
  });
});

describe("poll module: failures", () => {
  it("announces a failed run once per message, naming the job, and clears it on success", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    setup.outcomes["a"] = { exitCode: 1 };

    await setup.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    await setup.settle();

    expect(setup.cards).toEqual([
      expect.objectContaining({
        type: "error",
        title: "Test failed",
        message: "local:test automations.a: exit 1 — see the test",
      }),
    ]);
    expect(setup.poll.errors("test")).toMatchObject([
      { id: "a", message: "exit 1", logPath: expect.any(String) },
    ]);
    expect(setup.logs.map((log) => log.outcome)).toEqual(["failed", "failed"]);
    // The owner still sees the failed run.
    expect(setup.results[0]!.run.failure).toBe("exit 1");

    setup.outcomes["a"] = {};
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(setup.poll.errors()).toEqual([]);
  });

  it("fails a run whose owner returned errors, and logs it with the failures", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    setup.ownerErrors["a"] = ["item 0: bad", "item 2: worse"];

    await setup.start();
    await setup.settle();

    expect(setup.poll.errors()[0]?.message).toBe("item 0: bad; item 2: worse");
    expect(setup.logs[0]).toMatchObject({
      outcome: "failed",
      reason: "item 0: bad; item 2: worse",
    });
    expect(setup.cards).toHaveLength(1);
  });

  it("reports a shell that is not installed without running anything", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    setup.outcomes["a"] = { unavailable: true };

    await setup.start();

    expect(setup.results[0]!.run).toMatchObject({ status: "not-started" });
    expect(setup.poll.errors()[0]?.message).toBe("bash is not installed");
    expect(setup.logs).toEqual([]);
  });

  it("forgets the failure of a job that is no longer collected", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    setup.outcomes["a"] = { exitCode: 1 };
    await setup.start();
    expect(setup.poll.errors()).toHaveLength(1);

    setup.setJobs([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(setup.poll.errors()).toEqual([]);
  });

  it("lists exit 75 as retrying, and raises it only once it has lasted ten minutes", async () => {
    const setup = createSetup();
    setup.setJobs([job("a")]);
    setup.outcomes["a"] = { exitCode: 75 };
    await setup.start();
    await setup.settle();

    expect(setup.results[0]!.run).toMatchObject({ temporary: true });
    expect(setup.poll.errors()[0]?.message).toBe("temporary failure (exit 75), retrying");
    expect(setup.cards).toEqual([]);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await setup.settle();
    expect(setup.poll.errors()[0]?.message).toBe("exit 75");
    expect(setup.cards.map((card) => card.message)).toEqual([
      "local:test automations.a: exit 75 — see the test",
    ]);
  });
});
