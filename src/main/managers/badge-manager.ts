/**
 * Badge Manager - manages app icon badge for workspace status.
 * Displays a visual indicator on the app icon showing overall workspace state:
 * - No badge: All workspaces are ready (idle)
 * - Red circle: All workspaces are working (busy)
 * - Half red/half green: Mixed state (some ready, some working)
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
 * Badge state representing overall workspace status.
 * - "none": No badge (all ready or no workspaces)
 * - "all-working": Red circle (all workspaces are busy)
 * - "mixed": Half red/half green (some ready, some working)
 */
export type BadgeState = "none" | "all-working" | "mixed";

/**
 * Manages the app icon badge across platforms.
 *
 * Platform behavior:
 * - macOS: Uses dock.setBadge() with status indicator
 * - Windows: Uses overlay icon on taskbar (16x16 generated image)
 * - Linux: Uses setBadgeCount() for Unity launcher (1 for working, 0 otherwise)
 */
export class BadgeManager {
  private readonly platformInfo: PlatformInfo;
  private readonly appApi: ElectronAppApi;
  private readonly windowManager: WindowManager;
  private readonly logger: Logger;

  /**
   * Cache for generated badge images (Windows only).
   * Key is the badge state, value is the generated NativeImage.
   */
  private readonly imageCache = new Map<BadgeState, NativeImage>();

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
   * Updates the app icon badge with the given state.
   *
   * @param state - The badge state to display
   */
  updateBadge(state: BadgeState): void {
    switch (this.platformInfo.platform) {
      case "darwin":
        this.updateDarwinBadge(state);
        break;
      case "win32":
        this.updateWindowsBadge(state);
        break;
      case "linux":
        this.updateLinuxBadge(state);
        break;
      default:
        // Other platforms: no-op
        break;
    }
  }

  /**
   * Updates the macOS dock badge.
   * Uses Unicode circle characters for visual indication.
   */
  private updateDarwinBadge(state: BadgeState): void {
    // Use Unicode symbols: ● (filled circle) for working, ◐ (half circle) for mixed
    let badge: string;
    switch (state) {
      case "all-working":
        badge = "●"; // Filled circle for all working
        break;
      case "mixed":
        badge = "◐"; // Half-filled circle for mixed
        break;
      default:
        badge = ""; // Clear badge
    }
    this.appApi.dock?.setBadge(badge);
    this.logger.debug("Updated macOS dock badge", { state, badge });
  }

  /**
   * Updates the Windows taskbar overlay icon.
   */
  private updateWindowsBadge(state: BadgeState): void {
    if (state === "none") {
      // Clear overlay
      this.windowManager.setOverlayIcon(null, "");
      this.logger.debug("Cleared Windows overlay icon");
      return;
    }

    const image = this.getOrCreateBadgeImage(state);
    const description =
      state === "all-working" ? "All workspaces working" : "Some workspaces ready";
    this.windowManager.setOverlayIcon(image, description);
    this.logger.debug("Updated Windows overlay icon", { state, description });
  }

  /**
   * Updates the Linux badge count (Unity launcher).
   * Uses 1 for any active state, 0 for none.
   */
  private updateLinuxBadge(state: BadgeState): void {
    // Linux badge only supports counts, so use 1 for any visible state
    const count = state === "none" ? 0 : 1;
    const success = this.appApi.setBadgeCount(count);
    this.logger.debug("Updated Linux badge count", { state, count, success });
  }

  /**
   * Gets a cached badge image or creates a new one.
   */
  private getOrCreateBadgeImage(state: BadgeState): NativeImage {
    const cached = this.imageCache.get(state);
    if (cached) {
      return cached;
    }

    const image = this.generateBadgeImage(state);
    this.imageCache.set(state, image);
    return image;
  }

  /**
   * Generates a 16x16 badge image for the given state.
   * - "all-working": Red circle with light red border
   * - "mixed": Left half green, right half red, each with light-colored borders
   *
   * Note: SVG data URLs don't work on Windows (createFromDataURL returns empty image).
   * We use createFromBitmap with raw BGRA pixel data instead.
   *
   * @param state - The badge state (must not be "none")
   * @returns NativeImage suitable for overlay icon
   */
  private generateBadgeImage(state: BadgeState): NativeImage {
    const size = 16;
    const buffer = Buffer.alloc(size * size * 4);

    const centerX = size / 2;
    const centerY = size / 2;
    const innerRadius = 4.5; // 2/3 of original 7
    const outerRadius = 5.5; // 1px border

    // Colors
    const red = { r: 229, g: 20, b: 0 }; // #E51400 - working/busy
    const green = { r: 22, g: 163, b: 74 }; // #16A34A - ready/idle
    const lightRed = { r: 255, g: 160, b: 150 }; // Light red for border
    const lightGreen = { r: 144, g: 238, b: 144 }; // Light green for border

    if (state === "all-working") {
      // Draw red circle with light red border
      this.drawCircleWithBorder(
        buffer,
        size,
        centerX,
        centerY,
        innerRadius,
        outerRadius,
        red,
        lightRed
      );
    } else if (state === "mixed") {
      // Draw half-green (left), half-red (right) with respective light borders
      this.drawSplitCircleWithBorder(
        buffer,
        size,
        centerX,
        centerY,
        innerRadius,
        outerRadius,
        green,
        lightGreen,
        red,
        lightRed
      );
    }

    return nativeImage.createFromBitmap(buffer, { width: size, height: size });
  }

  /**
   * Draws a filled circle with a border ring and anti-aliased edges.
   */
  private drawCircleWithBorder(
    buffer: Buffer,
    size: number,
    centerX: number,
    centerY: number,
    innerRadius: number,
    outerRadius: number,
    fillColor: { r: number; g: number; b: number },
    borderColor: { r: number; g: number; b: number }
  ): void {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - centerX + 0.5;
        const dy = y - centerY + 0.5;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const offset = (y * size + x) * 4;

        if (distance <= outerRadius) {
          // Anti-alias the outer edge
          const outerEdgeDistance = outerRadius - distance;
          const alpha = outerEdgeDistance < 1 ? Math.floor(outerEdgeDistance * 255) : 255;

          // Choose color: inner fill or border
          const color = distance <= innerRadius ? fillColor : borderColor;

          // createFromBitmap uses BGRA format on Windows
          buffer[offset] = color.b; // B
          buffer[offset + 1] = color.g; // G
          buffer[offset + 2] = color.r; // R
          buffer[offset + 3] = alpha; // A
        }
        // Pixels outside circle remain zero (transparent)
      }
    }
  }

  /**
   * Draws a split circle with borders: left half in leftColor, right half in rightColor.
   * Each half has its own border color. A 1-pixel translucent gap separates the two halves.
   */
  private drawSplitCircleWithBorder(
    buffer: Buffer,
    size: number,
    centerX: number,
    centerY: number,
    innerRadius: number,
    outerRadius: number,
    leftFillColor: { r: number; g: number; b: number },
    leftBorderColor: { r: number; g: number; b: number },
    rightFillColor: { r: number; g: number; b: number },
    rightBorderColor: { r: number; g: number; b: number }
  ): void {
    // Gap is centered at x = centerX (columns 7 and 8 in 0-indexed 16px)
    const gapX = Math.floor(centerX);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - centerX + 0.5;
        const dy = y - centerY + 0.5;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const offset = (y * size + x) * 4;

        if (distance <= outerRadius) {
          // Check if this pixel is in the gap (1px wide at center)
          if (x === gapX) {
            // Gap pixel - translucent (alpha = 0, fully transparent)
            continue;
          }

          // Anti-alias the outer edge
          const outerEdgeDistance = outerRadius - distance;
          const alpha = outerEdgeDistance < 1 ? Math.floor(outerEdgeDistance * 255) : 255;

          // Choose color based on which side of the gap and whether in border or fill
          const isLeftSide = x < gapX;
          const isInnerFill = distance <= innerRadius;

          let color: { r: number; g: number; b: number };
          if (isLeftSide) {
            color = isInnerFill ? leftFillColor : leftBorderColor;
          } else {
            color = isInnerFill ? rightFillColor : rightBorderColor;
          }

          // createFromBitmap uses BGRA format on Windows
          buffer[offset] = color.b; // B
          buffer[offset + 1] = color.g; // G
          buffer[offset + 2] = color.r; // R
          buffer[offset + 3] = alpha; // A
        }
        // Pixels outside circle remain zero (transparent)
      }
    }
  }

  /**
   * Connects to the AgentStatusManager to receive status updates.
   * When status changes, the badge is updated with the aggregated state.
   *
   * @param statusManager - The AgentStatusManager to subscribe to
   */
  connectToStatusManager(statusManager: AgentStatusManager): void {
    // Clean up any existing subscription
    this.disconnect();

    // Subscribe to status changes
    this.statusManagerUnsubscribe = statusManager.onStatusChanged(() => {
      const statuses = statusManager.getAllStatuses();
      const state = this.aggregateWorkspaceStates(statuses);
      this.updateBadge(state);
    });

    // Perform initial update with current state
    const statuses = statusManager.getAllStatuses();
    const state = this.aggregateWorkspaceStates(statuses);
    this.updateBadge(state);

    this.logger.info("Connected to AgentStatusManager", {
      initialState: state,
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
      this.updateBadge("none");
      this.logger.debug("Disconnected from AgentStatusManager");
    }
  }

  /**
   * Aggregates workspace statuses into a single badge state.
   *
   * Logic:
   * - "none": No workspaces with agents, or all workspaces are ready (idle)
   * - "all-working": All workspaces with agents are busy
   * - "mixed": Some workspaces ready, some working
   *
   * Note: Workspaces with "mixed" status (both idle and busy agents) count as "working"
   * since they have active work in progress.
   *
   * @param statuses - Map of workspace paths to their aggregated statuses
   * @returns Badge state to display
   */
  private aggregateWorkspaceStates(
    statuses: Map<WorkspacePath, AggregatedAgentStatus>
  ): BadgeState {
    let hasReady = false;
    let hasWorking = false;

    for (const status of statuses.values()) {
      switch (status.status) {
        case "idle":
          // Workspace is fully ready (all agents idle)
          hasReady = true;
          break;
        case "busy":
        case "mixed":
          // Workspace has at least one busy agent
          hasWorking = true;
          break;
        // "none" status doesn't affect the badge
      }
    }

    if (!hasReady && !hasWorking) {
      // No workspaces with agents
      return "none";
    }
    if (hasReady && !hasWorking) {
      // All workspaces are ready - no badge
      return "none";
    }
    if (!hasReady && hasWorking) {
      // All workspaces are working - red circle
      return "all-working";
    }
    // Some ready, some working - mixed badge
    return "mixed";
  }
}
