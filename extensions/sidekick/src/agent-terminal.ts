/**
 * The agent terminal: the one editor terminal running the workspace's agent
 * CLI. Opening, adopting one that outlived the extension host, stopping the
 * agent, and reporting the terminal's lifecycle to CodeHydra (which drives the
 * agent status: "open" → WrapperStart, "close" → WrapperEnd / TUI detach).
 *
 * Also the shutdown helper that kills every terminal of the window.
 */
import * as vscode from "vscode";
import * as path from "path";
import { connectedSocket, log } from "./connection";
import type { AgentType } from "./types";

/** Timeout for terminal kill operations in milliseconds */
const TERMINAL_KILL_TIMEOUT_MS = 5000;

/** Interval between Ctrl+C signals in milliseconds */
const AGENT_CLOSE_SIGNAL_INTERVAL_MS = 500;

/**
 * How long to keep signalling before giving up (ms).
 *
 * This bounds the Ctrl+C loop only — it does NOT dispose the terminal. An agent
 * that has ignored ~12 signals is not going to take the next one, and the main
 * process has its own, longer bound after which it falls back to process
 * cleanup.
 */
const AGENT_CLOSE_SIGNAL_DEADLINE_MS = 6000;

/** workspaceState key remembering whether the agent terminal was open. */
const AGENT_TERMINAL_OPEN_KEY = "agentTerminalOpen";

interface AgentTerminalState {
  /** Singleton terminal for the agent CLI. */
  terminal: vscode.Terminal | null;
  /**
   * The agent terminal once its shell has started running the launch line, as
   * reported by shell integration. Until then there is no agent to stop — see
   * closeAgentTerminal.
   */
  launched: vscode.Terminal | null;
  /** Agent type and env from the server's config, for "Open Agent". */
  agentType: AgentType | null;
  agentEnv: Record<string, string> | null;
  /** Where the open/closed preference survives a restart. */
  workspaceState: vscode.Memento | null;
  closeListener: vscode.Disposable | null;
  startListener: vscode.Disposable | null;
}

const state: AgentTerminalState = {
  terminal: null,
  launched: null,
  agentType: null,
  agentEnv: null,
  workspaceState: null,
  closeListener: null,
  startListener: null,
};

/**
 * Report an agent terminal lifecycle transition to the main process.
 * Fire-and-forget; no-op when not connected.
 */
function emitAgentLifecycle(event: "open" | "close"): void {
  const socket = connectedSocket();
  if (!socket) return;
  socket.emit("api:workspace:agentLifecycle", { event });
  log.debug("Agent lifecycle reported", { event });
}

/**
 * The line typed into the agent terminal: the launcher, plus whatever makes the
 * shell go away with it.
 *
 * The terminal must close when the agent exits. Its close is the "close" agent
 * lifecycle event, which is what workspace teardown waits for after asking the
 * agent to stop — a bare `ch claude` leaves the shell at its prompt, the terminal
 * open, and every deletion waiting out api-server's full timeout.
 *
 * The shell is the terminal's default profile, so the syntax follows
 * `vscode.env.shell`. PowerShell gets `finally` rather than `; exit` because
 * Ctrl+C — how teardown stops the agent — abandons the rest of a statement list
 * but still runs `finally`. An unknown shell on Windows is assumed to be
 * PowerShell, VS Code's default there.
 */
function launchLine(command: string): string {
  const shell = path.win32.basename(vscode.env.shell).toLowerCase();
  if (shell === "cmd.exe" || shell === "cmd") return `${command} & exit`;
  if (
    shell.startsWith("powershell") ||
    shell.startsWith("pwsh") ||
    (shell === "" && process.platform === "win32")
  ) {
    return `try { ${command} } finally { exit }`;
  }
  return `exec ${command}`;
}

/**
 * Find an agent terminal that outlived the extension host that created it.
 *
 * Terminals belong to the window, not the extension host: when the extension
 * host restarts (a crash, or "Restart Extension Host") the agent terminal and
 * the agent in it keep running, but this module's state starts empty. A new
 * extension host still sees the terminal, with `creationOptions` rebuilt from
 * its launch config — including the env we passed. Only the agent terminal is
 * created with that env (config.env, see the agent providers'
 * getEnvironmentVariables), so `_CH_WORKSPACE` in it identifies the agent
 * terminal. The workspace env (applyWorkspaceEnv) does not interfere: VS Code
 * applies the environment variable collection when the process launches, and
 * it never appears in `creationOptions.env`. Should there be several, the first
 * one wins.
 */
function findRunningAgentTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find((t) => {
    const opts = t.creationOptions as vscode.TerminalOptions | undefined;
    return opts?.env?._CH_WORKSPACE !== undefined;
  });
}

/**
 * Open agent terminal in the editor area.
 * Adopts a still-running agent terminal if there is one (see
 * findRunningAgentTerminal), creates a new terminal if none exists, and
 * otherwise focuses the existing one.
 * On reopened workspaces (show=false), disposes any stale restored terminals
 * (which have lost their name/env after code-server restart) and creates a
 * fresh terminal with correct name, env vars, and command.
 *
 * @param agentType - The type of agent ("opencode" or "claude")
 * @param env - Environment variables to set for the terminal
 * @param show - Whether to show/focus the terminal (default: true)
 */
function openAgentTerminal(
  agentType: AgentType,
  env: Record<string, string>,
  show: boolean = true
): void {
  if (!state.terminal) {
    const running = findRunningAgentTerminal();
    if (running) {
      // The agent is already running and reporting its own status: no launch
      // line, and no "open" lifecycle event (it would reset a busy agent to
      // idle). Its shell ran the launch line long ago, so a close sends Ctrl+C.
      state.terminal = running;
      state.launched = running;
      log.debug("Adopted running agent terminal", { agentType });
    }
  }

  if (state.terminal) {
    if (show) state.terminal.show();
    return;
  }

  const terminalName = agentType === "claude" ? "Claude" : "OpenCode";
  // The `ch` CLI carries both launchers. The `ch-claude` script still exists,
  // but only because the Claude Code extension's process-wrapper setting takes a
  // bare path; nothing needs it here.
  const command = launchLine(agentType === "claude" ? "ch claude" : "ch opencode");

  if (!show) {
    // Reopened workspace: dispose stale restored terminals (empty creationOptions
    // indicate a terminal restored after pty host reconnection failure)
    for (const t of vscode.window.terminals) {
      const opts = t.creationOptions as vscode.TerminalOptions | undefined;
      if (opts?.name === undefined) {
        t.dispose();
      }
    }

    // Respect user preference: if they closed the terminal before restart, don't recreate
    const wasOpen = state.workspaceState?.get<boolean>(AGENT_TERMINAL_OPEN_KEY, true) ?? true;
    if (!wasOpen) {
      return;
    }
  }

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    location: { viewColumn: vscode.ViewColumn.Active },
    env: env,
    isTransient: true,
  });
  state.terminal = terminal;

  terminal.show();
  terminal.sendText(command);
  void state.workspaceState?.update(AGENT_TERMINAL_OPEN_KEY, true);

  // Agent terminal created → agent is starting (replaces wrapper's WrapperStart).
  emitAgentLifecycle("open");

  log.debug("Agent terminal opened", { agentType, command });
}

/**
 * Start tracking the agent terminal: its close (resetting the singleton and
 * reporting "close") and its shell's first execution (the launch line).
 * Idempotent.
 */
export function initAgentTerminal(workspaceState: vscode.Memento): void {
  state.workspaceState = workspaceState;
  if (state.closeListener) {
    return;
  }

  state.closeListener = vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === state.terminal) {
      state.terminal = null;
      void state.workspaceState?.update(AGENT_TERMINAL_OPEN_KEY, false);
      // Agent terminal closed → agent gone (replaces wrapper's WrapperEnd).
      emitAgentLifecycle("close");
      log.debug("Agent terminal closed");
    }
    if (terminal === state.launched) state.launched = null;
  });

  // The launch line is the first thing the agent terminal's shell runs.
  state.startListener = vscode.window.onDidStartTerminalShellExecution((event) => {
    if (event.terminal === state.terminal) state.launched = event.terminal;
  });
}

/**
 * The server configured an agent: remember it for "Open Agent" and open its
 * terminal (shown unless this is a reopened workspace — see openAgentTerminal).
 */
export function configureAgent(
  agentType: AgentType,
  env: Record<string, string>,
  show: boolean
): void {
  state.agentType = agentType;
  state.agentEnv = env;
  openAgentTerminal(agentType, env, show);
}

/**
 * Open (or focus) the configured agent's terminal. False when no agent has
 * been configured yet.
 */
export function openConfiguredAgent(): boolean {
  if (state.agentType === null || state.agentEnv === null) return false;
  openAgentTerminal(state.agentType, state.agentEnv);
  return true;
}

/**
 * Ask the agent to exit by sending Ctrl+C until its terminal closes.
 *
 * Claude Code needs two Ctrl+C in succession (the first interrupts, the second
 * exits), which is why this repeats rather than signalling once.
 *
 * There is deliberately NO force-dispose on a timeout. Disposing the terminal
 * does not stop the agent: with VS Code's persistent terminal sessions the pty
 * — and the whole tree below it, shell, agent CLI, and the MCP servers the
 * agent spawned — keeps running, now detached, with the workspace as its CWD.
 * All a dispose achieves is firing onDidCloseTerminal, which the main process
 * reads as "the agent exited" and proceeds to remove a worktree the agent is
 * still sitting in. Reporting a close we cannot back up is worse than not
 * reporting one: the caller has its own bound (api-server-module's
 * AGENT_CLOSE_TIMEOUT_MS) and can fall back to process cleanup, which it cannot
 * do if we tell it everything is fine.
 *
 * Returns whether there was a terminal to close. Closing itself is
 * asynchronous — completion is reported to the main process by the
 * onDidCloseTerminal listener, as the "close" agent lifecycle event.
 */
export function closeAgentTerminal(): boolean {
  const terminal = state.terminal;
  if (!terminal) {
    return false;
  }

  // No agent yet: its shell has not run the launch line. Ctrl+C now would not
  // stop an agent — it would reach the shell while it is still starting, where
  // the tty driver flushes pending input on the interrupt, so the typed launch
  // line is discarded and the shell sits at its prompt with the terminal open
  // for good. Dispose instead: there is nothing inside to outlive it.
  //
  // A shell without shell integration never reports the start, so it lands
  // here too even with an agent running. The close is then reported early;
  // the CWD scan before worktree removal is the backstop for that case.
  if (terminal !== state.launched) {
    log.debug("Agent not started; disposing its terminal");
    terminal.dispose();
    return true;
  }

  // Send Ctrl+C repeatedly until the terminal closes on its own.
  terminal.sendText("\x03", false);
  const signalInterval = setInterval(() => {
    terminal.sendText("\x03", false);
  }, AGENT_CLOSE_SIGNAL_INTERVAL_MS);

  const stopSignalling = (): void => {
    clearInterval(signalInterval);
    clearTimeout(deadline);
    disposable.dispose();
  };

  // Give up signalling — but leave the terminal alone. See the note above on
  // why a force-dispose here would be actively harmful.
  const deadline = setTimeout(() => {
    stopSignalling();
    log.debug("Agent did not exit; stopped signalling (terminal left running)");
  }, AGENT_CLOSE_SIGNAL_DEADLINE_MS);

  const disposable = vscode.window.onDidCloseTerminal((closed) => {
    if (closed === terminal) {
      stopSignalling();
    }
  });

  return true;
}

/** Stop tracking and forget the agent (the terminal itself is left to VS Code). */
export function resetAgentTerminal(): void {
  state.closeListener?.dispose();
  state.closeListener = null;
  state.startListener?.dispose();
  state.startListener = null;
  state.launched = null;
  state.terminal = null;
  state.agentType = null;
  state.agentEnv = null;
  state.workspaceState = null;
}

/** Dispose every terminal of the window and wait (bounded) for them to close. */
export async function killAllTerminalsAndWait(): Promise<void> {
  const terminals = [...vscode.window.terminals];

  if (terminals.length === 0) {
    log.debug("No terminals to kill");
    return;
  }

  log.debug("Killing terminals", { count: terminals.length });
  const pendingTerminals = new Set(terminals);

  await new Promise<void>((resolve) => {
    let resolved = false;

    const done = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      disposable.dispose();
      resolve();
    };

    const timeout = setTimeout(() => {
      log.warn("Terminal kill timeout", { remaining: pendingTerminals.size });
      done();
    }, TERMINAL_KILL_TIMEOUT_MS);

    const disposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
      pendingTerminals.delete(closedTerminal);
      log.debug("Terminal closed", { remaining: pendingTerminals.size });
      if (pendingTerminals.size === 0) {
        log.debug("All terminals closed");
        done();
      }
    });

    for (const terminal of terminals) {
      terminal.dispose();
    }

    if (pendingTerminals.size === 0) {
      log.debug("All terminals closed (sync)");
      done();
    }
  });
}
