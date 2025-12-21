/**
 * Badge Manager - manages app icon badge for idle workspace count.
 * Displays a badge on the app icon showing the count of idle workspaces.
 */

import { nativeImage, type NativeImage } from "electron";
import type { PlatformInfo } from "../../services/platform/platform-info";
import type { ElectronAppApi } from "./electron-app-api";
import type { WindowManager } from "./window-manager";
import type { Logger } from "../../services/logging";
import type { AgentStatusManager } from "../../services/opencode/agent-status-manager";
import type { WorkspacePath, AggregatedAgentStatus } from "../../shared/ipc";

/**
 * Unsubscribe function type.
 */
type Unsubscribe = () => void;

/**
 * Manages the app icon badge across platforms.
 *
 * Platform behavior:
 * - macOS: Uses dock.setBadge() for dock icon badge
 * - Windows: Uses overlay icon on taskbar (16x16 generated image)
 * - Linux: Uses setBadgeCount() for Unity launcher (silently fails elsewhere)
 */
export class BadgeManager {
  private readonly platformInfo: PlatformInfo;
  private readonly appApi: ElectronAppApi;
  private readonly windowManager: WindowManager;
  private readonly logger: Logger;

  /**
   * Cache for generated badge images (Windows only).
   * Key is the badge count, value is the generated NativeImage.
   */
  private readonly imageCache = new Map<number, NativeImage>();

  /**
   * Unsubscribe function for status manager subscription.
   */
  private statusManagerUnsubscribe: Unsubscribe | null = null;

  constructor(
    platformInfo: PlatformInfo,
    appApi: ElectronAppApi,
    windowManager: WindowManager,
    logger: Logger
  ) {
    this.platformInfo = platformInfo;
    this.appApi = appApi;
    this.windowManager = windowManager;
    this.logger = logger;
  }

  /**
   * Updates the app icon badge with the idle count.
   * Count of 0 clears the badge. Negative counts are treated as 0.
   *
   * @param idleCount - The number of idle workspaces to display
   */
  updateBadge(idleCount: number): void {
    // Normalize negative counts to 0
    const count = Math.max(0, idleCount);

    switch (this.platformInfo.platform) {
      case "darwin":
        this.updateDarwinBadge(count);
        break;
      case "win32":
        this.updateWindowsBadge(count);
        break;
      case "linux":
        this.updateLinuxBadge(count);
        break;
      default:
        // Other platforms: no-op
        break;
    }
  }

  /**
   * Updates the macOS dock badge.
   */
  private updateDarwinBadge(count: number): void {
    const badge = count > 0 ? String(count) : "";
    this.appApi.dock?.setBadge(badge);
    this.logger.debug("Updated macOS dock badge", { count, badge });
  }

  /**
   * Updates the Windows taskbar overlay icon.
   */
  private updateWindowsBadge(count: number): void {
    if (count === 0) {
      // Clear overlay
      this.windowManager.setOverlayIcon(null, "");
      this.logger.debug("Cleared Windows overlay icon");
      return;
    }

    const image = this.getOrCreateBadgeImage(count);
    const description = `${count} idle workspace${count === 1 ? "" : "s"}`;
    this.windowManager.setOverlayIcon(image, description);
    this.logger.debug("Updated Windows overlay icon", { count, description });
  }

  /**
   * Updates the Linux badge count (Unity launcher).
   */
  private updateLinuxBadge(count: number): void {
    const success = this.appApi.setBadgeCount(count);
    this.logger.debug("Updated Linux badge count", { count, success });
  }

  /**
   * Gets a cached badge image or creates a new one.
   */
  private getOrCreateBadgeImage(count: number): NativeImage {
    const cached = this.imageCache.get(count);
    if (cached) {
      return cached;
    }

    const image = this.generateBadgeImage(count);
    this.imageCache.set(count, image);
    return image;
  }

  /**
   * Generates a 16x16 badge image with the count.
   * The image is a red circle with white text.
   *
   * @param count - The number to display (must be > 0)
   * @returns NativeImage suitable for overlay icon
   */
  private generateBadgeImage(count: number): NativeImage {
    const text = String(count);
    // Adjust font size for larger numbers
    const fontSize = text.length === 1 ? 10 : text.length === 2 ? 8 : 6;

    const svg = `
      <svg width="16" height="16" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="7" fill="#E51400"/>
        <text x="8" y="12" text-anchor="middle"
              font-size="${fontSize}" font-weight="bold" font-family="Arial" fill="white">
          ${text}
        </text>
      </svg>`;

    return nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    );
  }

  /**
   * Connects to the AgentStatusManager to receive status updates.
   * When status changes, the badge is updated with the total idle count.
   *
   * @param statusManager - The AgentStatusManager to subscribe to
   */
  connectToStatusManager(statusManager: AgentStatusManager): void {
    // Clean up any existing subscription
    this.disconnect();

    // Subscribe to status changes
    this.statusManagerUnsubscribe = statusManager.onStatusChanged(() => {
      const statuses = statusManager.getAllStatuses();
      const idleCount = this.aggregateIdleCounts(statuses);
      this.updateBadge(idleCount);
    });

    // Perform initial update with current state
    const statuses = statusManager.getAllStatuses();
    const idleCount = this.aggregateIdleCounts(statuses);
    this.updateBadge(idleCount);

    this.logger.info("Connected to AgentStatusManager", {
      initialIdleCount: idleCount,
    });
  }

  /**
   * Disconnects from the AgentStatusManager.
   * Clears the badge when disconnected.
   */
  disconnect(): void {
    if (this.statusManagerUnsubscribe) {
      this.statusManagerUnsubscribe();
      this.statusManagerUnsubscribe = null;
      this.updateBadge(0);
      this.logger.debug("Disconnected from AgentStatusManager");
    }
  }

  /**
   * Aggregates idle counts from all workspace statuses.
   *
   * @param statuses - Map of workspace paths to their aggregated statuses
   * @returns Total idle count across all workspaces
   */
  private aggregateIdleCounts(statuses: Map<WorkspacePath, AggregatedAgentStatus>): number {
    let total = 0;
    for (const status of statuses.values()) {
      total += status.counts.idle;
    }
    return total;
  }
}
