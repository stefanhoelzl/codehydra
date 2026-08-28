/**
 * State mock for ProcessRunner following the State Mock Pattern.
 * Provides behavioral simulation with state tracking and custom matchers.
 */
import type {
  ProcessRunner,
  SpawnedProcess,
  ProcessResult,
  KillResult,
  ListeningProcess,
} from "./process";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";
import { createSnapshot } from "../../test/state-mock";

// =============================================================================
// Types and Interfaces
// =============================================================================

/**
 * Spawn record for partial matching in assertions.
 * All properties are optional to support partial matching.
 */
export interface SpawnRecord {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Kill call record for tracking kill invocations.
 */
interface KillCallRecord {
  readonly termTimeout: number | undefined;
  readonly killTimeout: number | undefined;
}

/**
 * State interface for MockSpawnedProcess.
 * Extends MockState for snapshot/toString support.
 */
export interface SpawnedProcessMockState extends MockState {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
  /** True when the caller asked for shell interpretation of `command`. */
  readonly shell: boolean;
  /** The replacement identity the caller passed as `redactBy`, if any. */
  readonly redactBy: string | undefined;
  readonly killCalls: ReadonlyArray<KillCallRecord>;
}

/**
 * State interface for MockProcessRunner.
 * Extends MockState for snapshot/toString support.
 */
export interface ProcessRunnerMockState extends MockState {
  /** Total number of processes spawned so far. */
  readonly spawnedCount: number;

  /**
   * Get spawned process by index.
   * @throws Error if index out of bounds
   */
  spawned(index: number): MockSpawnedProcess;

  /**
   * Get spawned process by command filter.
   * @throws Error if no match found
   */
  spawned(filter: { command: string }): MockSpawnedProcess;

  /** PIDs passed to `kill(pid, …)`, in call order. */
  readonly killedPids: readonly number[];
}

/**
 * Mock SpawnedProcess with inspectable state.
 */
export type MockSpawnedProcess = SpawnedProcess & MockWithState<SpawnedProcessMockState>;

/**
 * Mock ProcessRunner with inspectable state.
 */
export type MockProcessRunner = ProcessRunner & MockWithState<ProcessRunnerMockState>;

// =============================================================================
// Implementation Classes (Private)
// =============================================================================

/**
 * Options for creating a MockSpawnedProcess.
 */
interface MockSpawnedProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  shell: boolean;
  redactBy: string | undefined;
  pid: number | undefined;
  waitResult: ProcessResult;
  killResult: KillResult;
}

/**
 * Implementation of SpawnedProcessMockState.
 */
class SpawnedProcessMockStateImpl implements SpawnedProcessMockState {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly shell: boolean;
  readonly redactBy: string | undefined;
  private readonly _killCalls: KillCallRecord[] = [];

  constructor(options: {
    command: string;
    args: readonly string[];
    cwd: string | undefined;
    env: NodeJS.ProcessEnv | undefined;
    shell: boolean;
    redactBy: string | undefined;
  }) {
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    this.env = options.env;
    this.shell = options.shell;
    this.redactBy = options.redactBy;
  }

  get killCalls(): ReadonlyArray<KillCallRecord> {
    return this._killCalls;
  }

  recordKill(termTimeout: number | undefined, killTimeout: number | undefined): void {
    this._killCalls.push({ termTimeout, killTimeout });
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    const killCount = this._killCalls.length;
    return `SpawnedProcess(command=${this.command}, args=[${this.args.join(", ")}], cwd=${this.cwd ?? "undefined"}, killCalls=${killCount})`;
  }
}

/**
 * Implementation of MockSpawnedProcess.
 */
class MockSpawnedProcessImpl implements MockSpawnedProcess {
  readonly pid: number | undefined;
  private readonly state: SpawnedProcessMockStateImpl;
  private readonly waitResult: ProcessResult;
  private readonly killResult: KillResult;

  constructor(options: MockSpawnedProcessOptions) {
    this.pid = options.pid;
    this.waitResult = options.waitResult;
    this.killResult = options.killResult;
    this.state = new SpawnedProcessMockStateImpl({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      redactBy: options.redactBy,
    });
  }

  get $(): SpawnedProcessMockState {
    return this.state;
  }

  async wait(_timeout?: number): Promise<ProcessResult> {
    return this.waitResult;
  }

  async kill(termTimeout?: number, killTimeout?: number): Promise<KillResult> {
    this.state.recordKill(termTimeout, killTimeout);
    return this.killResult;
  }
}

/**
 * Implementation of ProcessRunnerMockState.
 */
class ProcessRunnerMockStateImpl implements ProcessRunnerMockState {
  private readonly processes: MockSpawnedProcess[] = [];
  private readonly killed: number[] = [];

  get spawnedCount(): number {
    return this.processes.length;
  }

  get killedPids(): readonly number[] {
    return this.killed;
  }

  addProcess(process: MockSpawnedProcess): void {
    this.processes.push(process);
  }

  addKilledPid(pid: number): void {
    this.killed.push(pid);
  }

  spawned(indexOrFilter: number | { command: string }): MockSpawnedProcess {
    if (typeof indexOrFilter === "number") {
      const index = indexOrFilter;
      const process = this.processes[index];
      if (process === undefined) {
        throw new Error(
          `No spawned process at index ${index}. Only ${this.processes.length} processes were spawned.`
        );
      }
      return process;
    }

    const { command } = indexOrFilter;
    const found = this.processes.find((p) => p.$.command === command);
    if (found === undefined) {
      const spawnedCommands = this.processes.map((p) => p.$.command).join(", ");
      throw new Error(
        `No spawned process with command '${command}'. Spawned commands: ${spawnedCommands || "(none)"}`
      );
    }
    return found;
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    if (this.processes.length === 0) {
      return "ProcessRunner(spawned=[])";
    }
    const procs = this.processes.map((p) => p.$.toString()).join(", ");
    return `ProcessRunner(spawned=[${procs}])`;
  }
}

/**
 * Callback type for onSpawn.
 */
type OnSpawnCallback = (
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined
) => SpawnConfig | void;

/**
 * Implementation of MockProcessRunner.
 */
class MockProcessRunnerImpl implements MockProcessRunner {
  private readonly state: ProcessRunnerMockStateImpl = new ProcessRunnerMockStateImpl();
  private readonly defaultResult: ProcessResult;
  private readonly defaultKillResult: KillResult;
  private readonly onSpawn: OnSpawnCallback | undefined;
  private readonly onKill: ((pid: number) => KillResult | void) | undefined;
  private readonly listeners: Map<number, ListeningProcess[]>;

  constructor(options?: MockProcessRunnerOptions) {
    this.defaultResult = {
      exitCode: options?.defaultResult?.exitCode ?? 0,
      stdout: options?.defaultResult?.stdout ?? "",
      stderr: options?.defaultResult?.stderr ?? "",
    };
    this.defaultKillResult = {
      success: true,
      reason: "SIGTERM",
    };
    this.onSpawn = options?.onSpawn;
    this.onKill = options?.onKill;
    this.listeners = new Map(
      Object.entries(options?.listeners ?? {}).map(([port, procs]) => [Number(port), [...procs]])
    );
  }

  async findListeningProcesses(port: number): Promise<ListeningProcess[]> {
    return [...(this.listeners.get(port) ?? [])];
  }

  async kill(pid: number, _termTimeout?: number, _killTimeout?: number): Promise<KillResult> {
    this.state.addKilledPid(pid);
    const result = this.onKill?.(pid) ?? this.defaultKillResult;
    // Behavioral: a killed process stops holding its port, so a re-scan after a
    // successful kill reports the port clean. A process that refused to die
    // keeps holding it.
    if (result.success) {
      for (const [port, procs] of this.listeners) {
        const remaining = procs.filter((proc) => proc.pid !== pid);
        if (remaining.length === 0) this.listeners.delete(port);
        else this.listeners.set(port, remaining);
      }
    }
    return result;
  }

  get $(): ProcessRunnerMockState {
    return this.state;
  }

  run(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; redactBy?: string }
  ): SpawnedProcess {
    // Get per-spawn configuration
    const config = this.onSpawn?.(command, args, options?.cwd, options?.env);

    // Determine pid (undefined = spawn failure)
    // Use 'in' check to distinguish between "property not set" and "property explicitly set to undefined"
    const pid = config !== null && config !== undefined && "pid" in config ? config.pid : 12345;

    // Determine wait result
    const waitResult: ProcessResult = {
      exitCode: config?.exitCode ?? this.defaultResult.exitCode,
      stdout: config?.stdout ?? this.defaultResult.stdout,
      stderr: config?.stderr ?? this.defaultResult.stderr,
      ...(config?.signal !== undefined && { signal: config.signal }),
      ...(config?.running !== undefined && { running: config.running }),
    };

    // Determine kill result
    const killResult: KillResult = config?.killResult ?? this.defaultKillResult;

    const process = new MockSpawnedProcessImpl({
      command,
      args,
      cwd: options?.cwd,
      env: options?.env,
      shell: options?.shell ?? false,
      redactBy: options?.redactBy,
      pid,
      waitResult,
      killResult,
    });

    this.state.addProcess(process);
    return process;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Configuration returned by onSpawn callback.
 */
export interface SpawnConfig {
  /** Process ID. undefined = spawn failure (ENOENT). Explicitly set to undefined for spawn failure. */
  pid?: number | undefined;
  /** Exit code for wait(). Default: 0. Use null to simulate process still running or killed by signal. */
  exitCode?: number | null;
  /** stdout for wait(). Default: "" */
  stdout?: string;
  /** stderr for wait(). Default: "" */
  stderr?: string;
  /** Signal name if killed. Default: undefined */
  signal?: string;
  /** True if process is still running after wait(timeout). Used for timeout simulation. */
  running?: boolean;
  /** Result for kill(). Default: { success: true, reason: "SIGTERM" } */
  killResult?: KillResult;
}

/**
 * Options for createMockProcessRunner factory.
 */
export interface MockProcessRunnerOptions {
  /**
   * Default result for all spawned processes.
   * Can be overridden per-spawn via onSpawn.
   */
  defaultResult?: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };

  /**
   * Called when run() is invoked. Return overrides for this spawn.
   * When this returns void or undefined, defaultResult is used.
   */
  onSpawn?: OnSpawnCallback;

  /**
   * Called when kill(pid, …) is invoked on a process we did not spawn.
   * Return an override to model a process that refuses to die; returning void
   * or undefined means it terminated.
   */
  onKill?: (pid: number) => KillResult | void;

  /**
   * Processes reported by findListeningProcesses(port), keyed by port.
   *
   * A port with no entry scans clean. Entries are dropped as their pids are
   * killed, so a caller that kills and re-scans sees the port free — which is
   * the loop the IDE server's port-conflict recovery runs.
   */
  listeners?: Readonly<Record<number, readonly ListeningProcess[]>>;
}

/**
 * Create a mock ProcessRunner with state tracking and custom matchers.
 *
 * @example
 * // Simple usage - all processes succeed
 * const runner = createMockProcessRunner();
 * const manager = new IdeServerManager(runner, ...);
 * await manager.ensureRunning();
 * expect(runner).toHaveSpawned([
 *   { command: "/path/to/codium-server" }
 * ]);
 *
 * @example
 * // Custom exit codes
 * const runner = createMockProcessRunner({
 *   defaultResult: { exitCode: 1, stderr: "error" }
 * });
 *
 * @example
 * // Per-spawn customization
 * const runner = createMockProcessRunner({
 *   onSpawn: (command) => {
 *     if (command.includes("codium-server")) {
 *       return { exitCode: 0, stdout: "started" };
 *     }
 *     return { exitCode: 1, stderr: "not found" };
 *   }
 * });
 */
export function createMockProcessRunner(options?: MockProcessRunnerOptions): MockProcessRunner {
  return new MockProcessRunnerImpl(options);
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Check if a value matches using asymmetric matcher or equality.
 */
function matchesValue(actual: unknown, expected: unknown): boolean {
  // Check for asymmetric matcher (from expect.stringContaining, etc.)
  if (typeof expected === "object" && expected !== null && "asymmetricMatch" in expected) {
    const matcher = expected as { asymmetricMatch: (actual: unknown) => boolean };
    return matcher.asymmetricMatch(actual);
  }

  // Array comparison - compare element by element
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (actual.length !== expected.length) {
      return false;
    }
    return expected.every((exp, i) => matchesValue(actual[i], exp));
  }

  // Direct equality for primitives
  return actual === expected;
}

/**
 * Check if actual spawns match expected records with partial matching.
 */
function matchesSpawnRecord(actual: SpawnedProcessMockState, expected: SpawnRecord): boolean {
  // Check command if specified
  if (expected.command !== undefined) {
    if (!matchesValue(actual.command, expected.command)) {
      return false;
    }
  }

  // Check args if specified
  if (expected.args !== undefined) {
    if (!matchesValue(actual.args, expected.args)) {
      return false;
    }
  }

  // Check cwd if specified
  if (expected.cwd !== undefined) {
    if (!matchesValue(actual.cwd, expected.cwd)) {
      return false;
    }
  }

  // Check env if specified
  if (expected.env !== undefined) {
    // Shallow comparison of env
    if (actual.env === undefined) {
      return false;
    }
    for (const key of Object.keys(expected.env)) {
      if (actual.env[key] !== expected.env[key]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Custom matchers for MockProcessRunner.
 */
interface ProcessRunnerMatchers {
  /**
   * Assert that processes matching expected records were spawned.
   * Supports partial matching - only specified fields are checked.
   */
  toHaveSpawned(expected: SpawnRecord[]): void;
}

/**
 * Custom matchers for MockSpawnedProcess.
 */
interface SpawnedProcessMatchers {
  /**
   * Assert that the process was killed (kill() was called at least once).
   */
  toHaveBeenKilled(): void;

  /**
   * Assert that the process was killed with specific timeout values.
   */
  toHaveBeenKilledWith(termTimeout?: number, killTimeout?: number): void;
}

// Vitest type augmentation
// Matchers are added unconditionally (standard pattern for testing libraries)
// Runtime checks ensure correct usage
declare module "vitest" {
  interface Assertion<T> extends ProcessRunnerMatchers, SpawnedProcessMatchers {}
}

/**
 * Matcher implementations for ProcessRunner.
 */
export const processRunnerMatchers: MatcherImplementationsFor<
  MockProcessRunner,
  ProcessRunnerMatchers
> = {
  toHaveSpawned(received, expected) {
    // Get all spawned processes
    const spawned: SpawnedProcessMockState[] = [];
    let index = 0;
    try {
      while (true) {
        spawned.push(received.$.spawned(index).$);
        index++;
      }
    } catch {
      // End of spawned processes
    }

    // Check each expected record
    const mismatches: string[] = [];

    for (let i = 0; i < expected.length; i++) {
      const exp = expected[i];
      if (exp === undefined) continue;

      const act = spawned[i];

      if (act === undefined) {
        mismatches.push(
          `Expected spawn at index ${i}: ${JSON.stringify(exp)}\nActual: (no spawn at this index)`
        );
        continue;
      }

      if (!matchesSpawnRecord(act, exp)) {
        mismatches.push(
          `Expected spawn at index ${i}: ${JSON.stringify(exp)}\nActual: ${act.toString()}`
        );
      }
    }

    // Check for extra spawns if we expect exact count
    if (spawned.length > expected.length) {
      for (let i = expected.length; i < spawned.length; i++) {
        const extra = spawned[i];
        if (extra !== undefined) {
          mismatches.push(`Unexpected spawn at index ${i}: ${extra.toString()}`);
        }
      }
    }

    const pass = mismatches.length === 0;

    return {
      pass,
      message: () =>
        pass
          ? `Expected not to have spawned: ${JSON.stringify(expected)}\nActual: ${received.$.toString()}`
          : `Spawn mismatch:\n${mismatches.join("\n")}\nActual state: ${received.$.toString()}`,
    };
  },
};

/**
 * Matcher implementations for SpawnedProcess.
 */
export const spawnedProcessMatchers: MatcherImplementationsFor<
  MockSpawnedProcess,
  SpawnedProcessMatchers
> = {
  toHaveBeenKilled(received) {
    const killCalls = received.$.killCalls;
    const pass = killCalls.length > 0;

    return {
      pass,
      message: () =>
        pass
          ? `Expected process not to have been killed.\nActual: ${received.$.toString()}`
          : `Expected process to have been killed.\nActual: ${received.$.toString()}`,
    };
  },

  toHaveBeenKilledWith(received, termTimeout, killTimeout) {
    const killCalls = received.$.killCalls;

    const found = killCalls.some(
      (call) => call.termTimeout === termTimeout && call.killTimeout === killTimeout
    );

    const pass = found;

    return {
      pass,
      message: () => {
        const expected = `kill(${termTimeout}, ${killTimeout})`;
        const actualCalls = killCalls
          .map((c) => `kill(${c.termTimeout}, ${c.killTimeout})`)
          .join(", ");
        return pass
          ? `Expected process not to have been killed with ${expected}.\nActual calls: [${actualCalls}]`
          : `Expected process to have been killed with ${expected}.\nActual calls: [${actualCalls || "none"}]\nState: ${received.$.toString()}`;
      },
    };
  },
};

// =============================================================================
// Auto-Registration
// =============================================================================

import { expect } from "vitest";

// Auto-register matchers when this file is imported
expect.extend({ ...processRunnerMatchers, ...spawnedProcessMatchers });
