/**
 * AgentBinaryManager - Manages agent binary (opencode/claude) preflight and download.
 *
 * Extracted from VscodeSetupService to separate agent binary management
 * from VS Code setup concerns. Delegates to BinaryDownloadService for
 * the actual download logic.
 */

import type { BinaryDownloadService } from "./binary-download-service";
import type { DownloadProgressCallback, BinaryType } from "./types";
import type { AgentType } from "../../agents/types";
import type { Logger } from "../logging";
import { BINARY_CONFIGS } from "./versions";
import { AgentBinaryError, getErrorMessage } from "../errors";

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
 * Excludes "code-server" since that's handled by CodeServerManager.
 */
export type AgentBinaryType = Exclude<BinaryType, "code-server">;

/**
 * Maps AgentType to AgentBinaryType.
 */
function agentTypeToBinaryType(agentType: AgentType): AgentBinaryType {
  return agentType === "claude" ? "claude" : "opencode";
}

/**
 * Manager for agent binary preflight and download operations.
 */
export class AgentBinaryManager {
  private readonly binaryType: AgentBinaryType;

  constructor(
    agentType: AgentType,
    private readonly binaryDownloadService: BinaryDownloadService,
    private readonly logger?: Logger
  ) {
    this.binaryType = agentTypeToBinaryType(agentType);
  }

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
      const config = BINARY_CONFIGS[this.binaryType];

      // Skip check for binaries without pinned versions (version: null)
      // These prefer system binary and don't need download
      if (config.version === null) {
        this.logger?.debug("Agent binary prefers system binary", { binaryType: this.binaryType });
        return {
          success: true,
          needsDownload: false,
        };
      }

      const isInstalled = await this.binaryDownloadService.isInstalled(this.binaryType);

      this.logger?.debug("Agent binary preflight", {
        binaryType: this.binaryType,
        isInstalled,
        needsDownload: !isInstalled,
      });

      return {
        success: true,
        needsDownload: !isInstalled,
        ...(isInstalled ? {} : { binaryType: this.binaryType }),
      };
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.warn("Agent binary preflight failed", {
        binaryType: this.binaryType,
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
    const config = BINARY_CONFIGS[this.binaryType];

    // Don't download binaries that prefer system binary
    if (config.version === null) {
      this.logger?.debug("Skipping agent binary download (prefers system)", {
        binaryType: this.binaryType,
      });
      return;
    }

    this.logger?.info("Downloading agent binary", { binaryType: this.binaryType });

    try {
      await this.binaryDownloadService.download(this.binaryType, onProgress);
      this.logger?.info("Agent binary download complete", { binaryType: this.binaryType });
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger?.warn("Agent binary download failed", {
        binaryType: this.binaryType,
        error: message,
      });
      throw new AgentBinaryError(`Failed to download ${this.binaryType}: ${message}`);
    }
  }

  /**
   * Get the binary type this manager handles.
   */
  getBinaryType(): AgentBinaryType {
    return this.binaryType;
  }
}
