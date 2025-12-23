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
   * The image is a red circle with white number.
   *
   * Note: SVG data URLs don't work on Windows (createFromDataURL returns empty image).
   * We use createFromBitmap with raw BGRA pixel data instead.
   *
   * @param count - The number to display (must be > 0)
   * @returns NativeImage suitable for overlay icon
   */
  private generateBadgeImage(count: number): NativeImage {
    const size = 16;
    const buffer = Buffer.alloc(size * size * 4);

    const centerX = size / 2;
    const centerY = size / 2;
    const radius = 7;

    // Red color: #E51400 (R=229, G=20, B=0)
    const red = { r: 229, g: 20, b: 0 };
    const white = { r: 255, g: 255, b: 255 };

    // Draw a filled red circle with anti-aliased edges
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - centerX + 0.5;
        const dy = y - centerY + 0.5;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const offset = (y * size + x) * 4;

        if (distance <= radius) {
          // Anti-alias the edge
          const edgeDistance = radius - distance;
          const alpha = edgeDistance < 1 ? Math.floor(edgeDistance * 255) : 255;

          // createFromBitmap uses BGRA format on Windows
          buffer[offset] = red.b; // B
          buffer[offset + 1] = red.g; // G
          buffer[offset + 2] = red.r; // R
          buffer[offset + 3] = alpha; // A
        }
        // Pixels outside circle remain zero (transparent)
      }
    }

    // Draw the number using simple bitmap font
    this.drawNumber(buffer, size, count, white);

    return nativeImage.createFromBitmap(buffer, { width: size, height: size });
  }

  /**
   * Draws a number onto the badge bitmap.
   * Uses simple pixel patterns for digits 0-9.
   */
  private drawNumber(
    buffer: Buffer,
    size: number,
    count: number,
    color: { r: number; g: number; b: number }
  ): void {
    const text = String(count);

    // Helper to draw a pixel in BGRA format
    const drawPixel = (x: number, y: number): void => {
      if (x >= 0 && x < size && y >= 0 && y < size) {
        const offset = (y * size + x) * 4;
        buffer[offset] = color.b;
        buffer[offset + 1] = color.g;
        buffer[offset + 2] = color.r;
        buffer[offset + 3] = 255;
      }
    };

    if (text.length === 1) {
      // Single digit - centered
      this.drawDigit(text, 5, 4, drawPixel);
    } else if (text.length === 2) {
      // Two digits - side by side
      this.drawDigit(text[0]!, 2, 4, drawPixel);
      this.drawDigit(text[1]!, 8, 4, drawPixel);
    } else {
      // 3+ digits - just show "+" to indicate overflow
      this.drawDigit("+", 5, 4, drawPixel);
    }
  }

  /**
   * Draws a single digit at the given position.
   * Each digit is approximately 5x8 pixels.
   */
  private drawDigit(
    digit: string,
    startX: number,
    startY: number,
    drawPixel: (x: number, y: number) => void
  ): void {
    // Simple 5x8 pixel patterns for digits
    const patterns: Record<string, number[][]> = {
      "0": [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
      ],
      "1": [
        [0, 0, 1, 0, 0],
        [0, 1, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 1, 1, 1, 0],
      ],
      "2": [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 1, 1, 0],
        [0, 1, 0, 0, 0],
        [1, 0, 0, 0, 0],
        [1, 1, 1, 1, 1],
      ],
      "3": [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 1, 1, 0],
        [0, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
      ],
      "4": [
        [0, 0, 0, 1, 0],
        [0, 0, 1, 1, 0],
        [0, 1, 0, 1, 0],
        [1, 0, 0, 1, 0],
        [1, 1, 1, 1, 1],
        [0, 0, 0, 1, 0],
        [0, 0, 0, 1, 0],
      ],
      "5": [
        [1, 1, 1, 1, 1],
        [1, 0, 0, 0, 0],
        [1, 1, 1, 1, 0],
        [0, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
      ],
      "6": [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 0],
        [1, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
      ],
      "7": [
        [1, 1, 1, 1, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 0, 1, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
      ],
      "8": [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
      ],
      "9": [
        [0, 1, 1, 1, 0],
        [1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1],
        [0, 1, 1, 1, 1],
        [0, 0, 0, 0, 1],
        [0, 0, 0, 0, 1],
        [0, 1, 1, 1, 0],
      ],
      "+": [
        [0, 0, 0, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [1, 1, 1, 1, 1],
        [0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0],
        [0, 0, 0, 0, 0],
      ],
    };

    const pattern = patterns[digit];
    if (!pattern) return;

    for (let row = 0; row < pattern.length; row++) {
      const patternRow = pattern[row];
      if (!patternRow) continue;
      for (let col = 0; col < patternRow.length; col++) {
        if (patternRow[col] === 1) {
          drawPixel(startX + col, startY + row);
        }
      }
    }
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
