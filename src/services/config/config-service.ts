/**
 * Configuration service for loading and saving application configuration.
 *
 * This is a pure service (not a boundary abstraction) that uses FileSystemLayer
 * for I/O operations. Configuration is stored as JSON in {dataRootDir}/config.json.
 */

import type { FileSystemLayer } from "../platform/filesystem";
import type { PathProvider } from "../platform/path-provider";
import type { Logger } from "../logging";
import type { AppConfig, ConfigAgentType } from "./types";
import { DEFAULT_APP_CONFIG } from "./types";

/**
 * Dependencies for ConfigService.
 */
export interface ConfigServiceDeps {
  readonly fileSystem: FileSystemLayer;
  readonly pathProvider: PathProvider;
  readonly logger: Logger;
}

/**
 * Service for managing application configuration.
 */
export class ConfigService {
  private readonly fileSystem: FileSystemLayer;
  private readonly pathProvider: PathProvider;
  private readonly logger: Logger;

  constructor(deps: ConfigServiceDeps) {
    this.fileSystem = deps.fileSystem;
    this.pathProvider = deps.pathProvider;
    this.logger = deps.logger;
  }

  /**
   * Load configuration from disk.
   * Returns default config if file doesn't exist.
   * Logs warning and returns defaults if JSON is corrupt.
   */
  async load(): Promise<AppConfig> {
    const configPath = this.pathProvider.configPath;

    try {
      const content = await this.fileSystem.readFile(configPath);
      const parsed = JSON.parse(content) as unknown;

      // Validate and return parsed config
      const validated = this.validateConfig(parsed);
      if (validated) {
        this.logger.debug("Config loaded", { path: configPath.toString() });
        return validated;
      }

      // Invalid structure, return defaults
      this.logger.warn("Config validation failed, using defaults", {
        path: configPath.toString(),
      });
      return DEFAULT_APP_CONFIG;
    } catch (error) {
      // File doesn't exist - expected on first run
      if (error instanceof Error && "fsCode" in error && error.fsCode === "ENOENT") {
        this.logger.debug("Config not found, using defaults", {
          path: configPath.toString(),
        });
        // Write defaults to disk for next time
        await this.save(DEFAULT_APP_CONFIG);
        return DEFAULT_APP_CONFIG;
      }

      // JSON parse error or other issue
      this.logger.warn("Config load failed, using defaults", {
        path: configPath.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_APP_CONFIG;
    }
  }

  /**
   * Save configuration to disk.
   */
  async save(config: AppConfig): Promise<void> {
    const configPath = this.pathProvider.configPath;

    // Ensure parent directory exists
    await this.fileSystem.mkdir(configPath.dirname);

    // Write formatted JSON
    const content = JSON.stringify(config, null, 2);
    await this.fileSystem.writeFile(configPath, content);

    this.logger.debug("Config saved", { path: configPath.toString() });
  }

  /**
   * Update the agent selection in config.
   */
  async setAgent(agent: ConfigAgentType): Promise<void> {
    const current = await this.load();
    const updated: AppConfig = {
      ...current,
      agent,
    };
    await this.save(updated);
    this.logger.info("Agent selection saved", { agent: agent ?? "none" });
  }

  /**
   * Validate that a parsed object is a valid AppConfig.
   * Returns the validated config or null if invalid.
   */
  private validateConfig(data: unknown): AppConfig | null {
    if (typeof data !== "object" || data === null) {
      return null;
    }

    const obj = data as Record<string, unknown>;

    // Check agent field
    if (obj.agent !== null && obj.agent !== "claude" && obj.agent !== "opencode") {
      return null;
    }

    // Check versions field
    if (typeof obj.versions !== "object" || obj.versions === null) {
      return null;
    }

    const versions = obj.versions as Record<string, unknown>;

    // claude and opencode can be string or null
    if (versions.claude !== null && typeof versions.claude !== "string") {
      return null;
    }
    if (versions.opencode !== null && typeof versions.opencode !== "string") {
      return null;
    }

    // codeServer must be string
    if (typeof versions.codeServer !== "string") {
      return null;
    }

    return {
      agent: obj.agent as ConfigAgentType,
      versions: {
        claude: versions.claude as string | null,
        opencode: versions.opencode as string | null,
        codeServer: versions.codeServer as string,
      },
    };
  }
}

/**
 * Create a ConfigService instance.
 */
export function createConfigService(deps: ConfigServiceDeps): ConfigService {
  return new ConfigService(deps);
}
