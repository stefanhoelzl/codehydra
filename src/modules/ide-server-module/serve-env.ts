/**
 * The environment the IDE server is spawned with.
 */

import type { SupportedPlatform } from "../../boundaries/platform/platform-info";
import { prependPath } from "../../utils/env-path";
import { Path } from "../../utils/path/path";
import type { IdeServer } from "./types";

export interface ServeEnvInput {
  /** The app's own environment, the starting point. */
  readonly env: NodeJS.ProcessEnv;
  /** CodeHydra's bin dir: put first on PATH, and home of the `code` editor wrapper. */
  readonly binDir: Path;
  readonly platform: SupportedPlatform;
  /** The active distribution descriptor. */
  readonly ide: IdeServer;
  /** Where that distribution's bundle is installed (native path). */
  readonly ideServerDir: string;
  /** The API server's port, when it is running. */
  readonly apiPort: number | undefined;
}

/**
 * Format a remote-cli's leading arguments for the platform's wrapper script.
 * Windows re-parses the expanded `%VAR%`, so each token is quoted; POSIX passes
 * them through unquoted (current distributions use no leading arguments there).
 */
function formatRemoteCliArgs(args: readonly string[], platform: SupportedPlatform): string {
  if (platform === "win32") {
    return args.map((arg) => `"${arg}"`).join(" ");
  }
  return args.join(" ");
}

/**
 * Build the IDE server's environment: the app's, minus any `VSCODE_*` variable
 * (CodeHydra may itself run from a VS Code terminal), with the bin dir first on
 * PATH, the `code` wrapper as EDITOR and GIT_SEQUENCE_EDITOR, the distribution's
 * own variables, and what the wrapper scripts read to reach the API server and
 * the distribution's remote CLI and node.
 */
export function buildServeEnv(input: ServeEnvInput): NodeJS.ProcessEnv {
  const { ide, platform } = input;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (!key.startsWith("VSCODE_")) env[key] = value;
  }

  const result = prependPath(env, input.binDir.toNative(), platform);

  const codeCmd =
    platform === "win32"
      ? `"${new Path(input.binDir, "code.cmd").toNative()}"`
      : new Path(input.binDir, "code").toNative();
  const editorValue = `${codeCmd} --wait --reuse-window`;
  result.EDITOR = editorValue;
  result.GIT_SEQUENCE_EDITOR = editorValue;

  Object.assign(result, ide.serveEnv());

  if (input.apiPort !== undefined) {
    result._CH_API_PORT = String(input.apiPort);
  }

  const remoteCli = ide.remoteCli(input.ideServerDir, platform);
  result._CH_IDE_REMOTE_CLI = remoteCli.exe;
  result._CH_IDE_REMOTE_CLI_ARGS = formatRemoteCliArgs(remoteCli.args, platform);
  result._CH_IDE_NODE = ide.nodeBinary(input.ideServerDir, platform);
  return result;
}
