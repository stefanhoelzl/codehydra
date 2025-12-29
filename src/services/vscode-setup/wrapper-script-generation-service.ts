/**
 * Service for generating CLI wrapper scripts.
 *
 * This service is responsible for creating wrapper scripts (code, opencode)
 * in the bin directory. It is designed to be called on every app startup
 * to ensure scripts are always fresh and match current binary versions.
 *
 * Script regeneration is cheap (~1ms) and has no side effects beyond writing
 * the scripts themselves, making it safe to run unconditionally.
 */

import type { PathProvider } from "../platform/path-provider";
import type { FileSystemLayer } from "../platform/filesystem";
import type { PlatformInfo } from "../platform/platform-info";
import type { Logger } from "../logging/index";
import { Path } from "../platform/path";
import { generateOpencodeConfigContent, generateScripts } from "./bin-scripts";
import type { BinTargetPaths } from "./types";

/**
 * Service for generating CLI wrapper scripts in the bin directory.
 */
export class WrapperScriptGenerationService {
  constructor(
    private readonly pathProvider: PathProvider,
    private readonly fs: FileSystemLayer,
    private readonly platformInfo: PlatformInfo,
    private readonly logger?: Logger
  ) {}

  /**
   * Regenerate all wrapper scripts in the bin directory.
   *
   * This method:
   * 1. Creates the bin directory if it doesn't exist
   * 2. Resolves target binary paths
   * 3. Generates platform-appropriate scripts (shell or .cmd)
   * 4. Writes scripts to disk with correct permissions
   *
   * Safe to call on every app startup - overwrites existing scripts.
   */
  async regenerate(): Promise<void> {
    const binDir = this.pathProvider.binDir;

    this.logger?.debug("Regenerating wrapper scripts", { binDir: binDir.toString() });

    // Create bin directory (no-op if exists)
    await this.fs.mkdir(binDir);

    // Resolve target binary paths
    const targetPaths = this.resolveTargetPaths();

    // Generate scripts for this platform - pass native path for bin scripts
    const scripts = generateScripts(this.platformInfo, targetPaths, binDir.toNative());

    // Write each script
    for (const script of scripts) {
      const scriptPath = new Path(binDir, script.filename);
      await this.fs.writeFile(scriptPath, script.content);

      // Make executable on Unix
      if (script.needsExecutable) {
        await this.fs.makeExecutable(scriptPath);
      }

      this.logger?.debug("Wrote wrapper script", { filename: script.filename });
    }

    // Regenerate OpenCode config (ensures default_agent is always set)
    await this.regenerateOpencodeConfig();

    this.logger?.info("Startup files regenerated", { scripts: scripts.length, config: 1 });
  }

  /**
   * Regenerate the OpenCode configuration file.
   *
   * This ensures the config is always up-to-date with current settings,
   * including the default_agent setting for plan mode.
   */
  private async regenerateOpencodeConfig(): Promise<void> {
    const configPath = this.pathProvider.mcpConfigPath;
    const configDir = configPath.dirname;

    // Ensure directory exists
    await this.fs.mkdir(configDir);

    // Generate and write config content
    const configContent = generateOpencodeConfigContent();
    await this.fs.writeFile(configPath, configContent);

    this.logger?.debug("Regenerated OpenCode config", { path: configPath.toString() });
  }

  /**
   * Resolve paths to target binaries for wrapper script generation.
   *
   * The code script points to code-server's remote-cli.
   * The opencode script points to the downloaded opencode binary.
   *
   * @returns Target paths for script generation
   */
  private resolveTargetPaths(): BinTargetPaths {
    // For the code command, we need the remote-cli script that code-server provides
    const codeServerDir = this.pathProvider.codeServerDir;
    const remoteCli = this.resolveRemoteCliPath(codeServerDir);

    return {
      codeRemoteCli: remoteCli.toNative(),
      opencodeBinary: this.pathProvider.opencodeBinaryPath.toNative(),
      bundledNodePath: this.pathProvider.bundledNodePath.toNative(),
    };
  }

  /**
   * Resolve the path to the remote-cli script for the `code` command.
   *
   * @param codeServerDir - Path to code-server installation directory
   * @returns Path to the remote-cli script
   */
  private resolveRemoteCliPath(codeServerDir: Path): Path {
    const isWindows = this.platformInfo.platform === "win32";

    if (isWindows) {
      return new Path(codeServerDir, "lib", "vscode", "bin", "remote-cli", "code.cmd");
    }

    // Unix: the script is named based on platform
    const platform = this.platformInfo.platform === "darwin" ? "darwin" : "linux";
    return new Path(codeServerDir, "lib", "vscode", "bin", "remote-cli", `code-${platform}.sh`);
  }
}
