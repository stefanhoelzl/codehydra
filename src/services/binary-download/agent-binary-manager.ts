/**
 * AgentBinaryManager - Manages agent binary (opencode/claude) preflight and download.
 *
 * Extracted from VscodeSetupService to separate agent binary management
 * from VS Code setup concerns. Delegates to BinaryDownloadService for
 * the actual download logic.
 */

import type { BinaryDownloadService } from "./binary-download-service";
import type { DownloadProgressCallback, DownloadRequest } from "./types";
import type { Logger } from "../logging";
import { AgentBinaryError, getErrorMessage } from "../errors";

/**
 * Configuration for an agent binary.
 */
export interface AgentBinaryConfig {
  /** Binary name ("claude" | "opencode") */
  readonly name: string;
  /** Version string, or null to skip download (prefers system binary) */
  readonly version: string | null;
  /** Extraction destination directory */
  readonly destDir: string;
  /** Download URL */
  readonly url: string;
  /** Relative path to the executable within the extracted directory */
  readonly executablePath: string;
  /** Subpath within the extracted archive to promote to destDir root */
  readonly subPath?: string;
}

/**
 * Preflight result for agent binary check.
 */
export interface AgentBinaryPreflightResult {
  /** True if the preflight check succeeded */
  readonly success: true;
  /** True if download is needed */
  readonly needsDownload: boolean;
  /** The binary type that needs download (if needsDownload is true) */
  readonly binaryType?: AgentBinaryType;
}

/**
 * Preflight error result.
 */
export interface AgentBinaryPreflightError {
  readonly success: false;
  readonly error: {
    readonly type: string;
    readonly message: string;
  };
}

/**
 * Agent binary type for download operations.
 */
export type AgentBinaryType = "opencode" | "claude";

/**
 * Manager for agent binary preflight and download operations.
 */
export class AgentBinaryManager {
  constructor(
    private readonly config: AgentBinaryConfig,
    private readonly binaryDownloadService: BinaryDownloadService,
    private readonly logger?: Logger
  ) {}

  /**
   * Check if the agent binary needs to be downloaded.
   *
   * Binaries with version: null (like Claude) prefer system binary and
   * don't need download - the BinaryResolutionService handles this at runtime.
   *
   * @returns Preflight result indicating if download is needed
   */
  async preflight(): Promise<AgentBinaryPreflightResult | AgentBinaryPreflightError> {
    try {
      // Skip check for binaries without pinned versions (version: null)
      // These prefer system binary and don't need download
      if (this.config.version === null) {
        this.logger?.debug("Agent binary prefers system binary", { name: this.config.name });
        return {
          success: true,
          needsDownload: false,
        };
      }

      const isInstalled = await this.binaryDownloadService.isInstalled(this.config.destDir);

      this.logger?.debug("Agent binary preflight", {
        name: this.config.name,
        isInstalled,
        needsDownload: !isInstalled,
      });

      return {
        success: true,
        needsDownload: !isInstalled,
        ...(isInstalled ? {} : { binaryType: this.config.name as AgentBinaryType }),
      };
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.warn("Agent binary preflight failed", {
        name: this.config.name,
        error: message,
      });
      return {
        success: false,
        error: {
          type: "preflight-failed",
          message,
        },
      };
    }
  }

  /**
   * Download the agent binary.
   *
   * @param onProgress Optional callback for progress updates
   * @throws AgentBinaryError if download fails
   */
  async downloadBinary(onProgress?: DownloadProgressCallback): Promise<void> {
    // Don't download binaries that prefer system binary
    if (this.config.version === null) {
      this.logger?.debug("Skipping agent binary download (prefers system)", {
        name: this.config.name,
      });
      return;
    }

    this.logger?.info("Downloading agent binary", { name: this.config.name });

    const request: DownloadRequest = {
      name: this.config.name,
      url: this.config.url,
      destDir: this.config.destDir,
      executablePath: this.config.executablePath,
      ...(this.config.subPath ? { subPath: this.config.subPath } : {}),
    };

    try {
      await this.binaryDownloadService.download(request, onProgress);
      this.logger?.info("Agent binary download complete", { name: this.config.name });
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.warn("Agent binary download failed", {
        name: this.config.name,
        error: message,
      });
      throw new AgentBinaryError(`Failed to download ${this.config.name}: ${message}`);
    }
  }

  /**
   * Get the binary type this manager handles.
   */
  getBinaryType(): AgentBinaryType {
    return this.config.name as AgentBinaryType;
  }
}
