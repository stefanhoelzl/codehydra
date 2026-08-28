/**
 * A busy IDE-server port is offered up for termination, not a dead end.
 *
 * The branches — accept, decline, kill-failed, nothing-found — are covered by
 * fast tests with behavioural mocks. What only a real launch can prove is the
 * part those mocks stand in for: that the platform scan actually finds a
 * listener on a real socket, reports a pid the user can recognize, and that
 * killing it frees the port for the retry.
 *
 * Since the single-instance lock shipped, reaching this code means no CodeHydra
 * on this data root is running, so the holder is a crashed session's leftover
 * or an unrelated process. The holder here is the latter: a bare node process
 * squatting on the port, which is exactly the case the dialog cannot make
 * assumptions about.
 */
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { freePort, resetDataState, type Agent } from "./env";
import { appLogEntries, failFastOnStartupFailure, launchApp, useApp } from "./fixtures";

/** A process that holds `port` and nothing else, for the app to find and kill. */
function spawnPortHolder(port: number): ChildProcess {
  return spawn(
    process.execPath,
    [
      "-e",
      // The interval is what keeps it alive: a listening socket alone does not
      // hold the event loop open once nothing is accepting.
      `require("net").createServer().listen(${port}, "127.0.0.1");` +
        `setInterval(() => {}, 1 << 30);`,
    ],
    { stdio: "ignore" }
  );
}

/**
 * Everything the app logged about finding the port's holder.
 *
 * The scan is best-effort and reports an empty result for a failed query as
 * well as a genuinely free port, so when the dialog does not appear these lines
 * are what distinguish "the tool is missing", "the query errored" and "it
 * really saw nothing".
 */
function scanLog(): string {
  const lines = appLogEntries()
    .filter((entry) => {
      const text = `${entry.scope ?? ""} ${entry.message ?? ""} ${JSON.stringify(entry.context ?? {})}`;
      return /listener|scan|lsof|powershell|Get-NetTCPConnection|IDE server/i.test(text);
    })
    .map(
      (entry) =>
        `[${entry.level ?? "?"}] ${entry.message ?? ""} ${JSON.stringify(entry.context ?? {})}`
    );
  return lines.length > 0 ? lines.join("\n") : "(the app logged nothing about the scan)";
}

/** Resolve once something is accepting connections on `port`. */
async function waitUntilListening(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Nothing was listening on port ${port} within ${timeoutMs}ms`);
}

// `cold`: the port has to be taken before the app launches, so this spec owns
// its own reset and launch. Teardown stays the fixture's.
const app = useApp({ cold: true });

test("offers to terminate whatever holds the IDE server port, then starts", async () => {
  const port = await freePort();
  const holder = spawnPortHolder(port);

  try {
    await waitUntilListening(port);
    expect(holder.pid, "the port holder should have a pid to show").toBeDefined();

    // Not optional, even though this spec creates nothing: without it the app
    // inherits the previous spec's project list, whose temp repos are gone by
    // now, and `project:open` logs an error that fails the fixture's teardown.
    resetDataState({ keepConfig: true });

    // Without the offer, the app dies on a native "Startup Failed" box and
    // never shows a UI — launchApp would then wait out its whole 120s and the
    // spec would fail on a bare test timeout. Racing surfaces the app's own
    // message in seconds instead.
    const startupFailure = failFastOnStartupFailure();
    try {
      await Promise.race([
        launchApp(app(), {
          agent: test.info().project.name as Agent,
          extraArgs: [`--ide-server.port=${port}`],
        }),
        startupFailure.promise,
      ]);
    } finally {
      startupFailure.stop();
    }

    const ui = app().uiPage();

    // The UI is up before the IDE server starts (show-ui runs two hook points
    // earlier), so the dialog arrives after launchApp has already resolved.
    try {
      await expect(ui.getByText("Port already in use")).toBeVisible({ timeout: 30_000 });
    } catch (error) {
      // No dialog means the platform scan reported nobody on the port, and the
      // scan's own log lines are the only thing that says why. Without them a
      // failure here is just "element not found" and the next attempt is a
      // guess — which is exactly how this spec burned three CI rounds.
      throw new Error(`The port-conflict dialog never appeared.\n\nPort scan log:\n${scanLog()}`, {
        cause: error,
      });
    }
    // The pid is the whole point of the dialog: it is what lets someone decide
    // whether this is their leftover or something they care about.
    await expect(ui.getByText(String(holder.pid), { exact: true })).toBeVisible();

    await ui.getByRole("button", { name: "Terminate and Continue" }).click();

    // Killed, port released, retry succeeded, app reached its normal UI.
    await expect(ui.getByText("Port already in use")).toBeHidden({ timeout: 30_000 });
    await expect(ui.getByRole("navigation", { name: "Projects" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(ui.getByRole("button", { name: "New workspace" })).toBeVisible();
  } finally {
    // No-op when the app already killed it; guards the failure paths.
    holder.kill("SIGKILL");
  }
});
