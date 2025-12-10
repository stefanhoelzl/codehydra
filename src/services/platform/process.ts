/**
 * Process spawning utilities.
 */

import { execa, type ResultPromise } from "execa";
import { createServer } from "net";

/**
 * Find an available port on the system.
 * Uses the Node.js net module to bind to port 0, which the OS assigns an available port.
 *
 * @returns Promise resolving to an available port number
 */
export async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port from server address")));
      }
    });
    server.on("error", reject);
  });
}

export interface SpawnProcessOptions {
  /** Working directory for the process */
  readonly cwd?: string;
  /** Environment variables */
  readonly env?: NodeJS.ProcessEnv;
  /** Timeout in milliseconds */
  readonly timeout?: number;
}

/**
 * Spawn a process with cleanup options.
 * Uses execa with cleanup: true to ensure child processes are terminated
 * when the parent exits.
 *
 * @param command Command to run
 * @param args Command arguments
 * @param options Spawn options
 * @returns Execa result promise with subprocess handle
 */
export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnProcessOptions = {}
): ResultPromise {
  return execa(command, args, {
    cleanup: true,
    ...(options.cwd && { cwd: options.cwd }),
    // When custom env is provided, disable extendEnv so that deleted keys
    // from the custom env are actually removed (not inherited from process.env)
    ...(options.env && { env: options.env, extendEnv: false }),
    ...(options.timeout && { timeout: options.timeout }),
    // Capture output as strings
    encoding: "utf8",
    // Don't reject on non-zero exit (we handle this ourselves)
    reject: true,
  });
}

/**
 * Result of running a process command.
 * Compatible with vscode-setup ProcessResult interface.
 */
export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * Interface for running external processes.
 * Allows dependency injection for testing.
 */
export interface ProcessRunner {
  run(command: string, args: readonly string[]): Promise<ProcessResult>;
}

/**
 * Process runner implementation using execa.
 */
export class ExecaProcessRunner implements ProcessRunner {
  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    try {
      const result = await execa(command, [...args], {
        cleanup: true,
        encoding: "utf8",
        reject: false, // Don't throw on non-zero exit
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (error) {
      // Handle ENOENT (binary not found) and other spawn errors
      const err = error as NodeJS.ErrnoException;
      return {
        stdout: "",
        stderr: err.message,
        exitCode: null,
      };
    }
  }
}
