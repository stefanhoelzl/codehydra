/**
 * The one script runner the app shares, and the setting it reads.
 *
 * A plugin's hooks run through it, and so does everything the poll module runs
 * each tick — automations and wakeup scripts. One runner means one place that
 * decides which program runs a script (`paths.bash` on Windows), which
 * environment it gets and where its temp files go.
 */

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { ProcessRunner } from "../../boundaries/platform/process";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import { storeFolder, type PersistedAccessor } from "../../boundaries/platform/store-definition";
import type { Path } from "../../utils/path/path";
import { createScriptRunner, type ScriptRunner } from "./script-runner";
import { createShellResolver } from "./shells";

export interface ScriptsDeps {
  readonly config: Config;
  readonly fileSystem: Pick<
    FileSystemBoundary,
    "mkdir" | "writeFile" | "readdir" | "rm" | "makeExecutable" | "realpath"
  >;
  readonly processRunner: ProcessRunner;
  readonly logger: Logger;
  /** Directory for the temp script files. */
  readonly tempDir: Path;
  /** Directory holding the `ch` CLI, prepended to every script's PATH. */
  readonly binDir: Path;
  /** Default: this process's. */
  readonly platform?: NodeJS.Platform;
  /** The environment scripts inherit and shells are searched in. Default: this process's. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Register `paths.bash` and build the runner that reads it. */
export function createScripts(deps: ScriptsDeps): ScriptRunner {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;

  const folder = storeFolder();
  const bashPath: PersistedAccessor<string | null> = deps.config.register("paths.bash", {
    default: null,
    description:
      "bash for plugin and wakeup scripts on Windows (default: Git Bash, found next to git on PATH)",
    applies: "live",
    parse: folder.parse,
    validate: folder.validate,
    validValues: "<absolute path to bash.exe>",
    // A file, not a folder: a plain text field rather than the folder picker.
    settingsControl: { kind: "string" },
  });

  return createScriptRunner({
    fileSystem: deps.fileSystem,
    processRunner: deps.processRunner,
    shells: createShellResolver({
      fileSystem: deps.fileSystem,
      platform,
      env,
      bashOverride: () => bashPath.get(),
    }),
    logger: deps.logger,
    tempDir: deps.tempDir,
    binDir: deps.binDir,
    env,
    platform,
  });
}
