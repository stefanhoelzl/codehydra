/**
 * OsNotificationBoundary - Abstraction over Electron's Notification.
 *
 * The *OS* notification channel — a desktop toast raised by the platform
 * (Windows Action Center, GNOME/KDE, macOS Notification Center). Distinct from
 * the in-app sidebar notifications the presenter owns (`UiPresenter.notification()`,
 * `clone-notification-module`, `error-notification-module`), which render inside
 * CodeHydra's own UI and are useless when the window is not on screen — which is
 * exactly when this channel is used.
 *
 * The OS default sound is left alone: CodeHydra's `silent` config governs the
 * renderer's chime only, and the two are independent channels.
 *
 * Provides an injectable interface, enabling:
 * - Integration testing with a behavioral mock
 * - Boundary testing against a mocked Electron Notification
 * - Handle-based access (no Electron types cross the boundary)
 */

import type { Logger } from "../platform/logging";

// ============================================================================
// Types
// ============================================================================

/**
 * An opaque reference to a shown notification, used to close it later.
 *
 * Branded so a caller cannot fabricate one or confuse it with another handle
 * type, matching ImageHandle/WindowHandle.
 */
export interface OsNotificationHandle {
  readonly id: string;
  readonly __brand: "OsNotificationHandle";
}

/** What to show, and what to do when the user clicks it. */
export interface OsNotificationOptions {
  /** Bold first line. */
  readonly title: string;
  /** Secondary line beneath the title. */
  readonly body: string;
  /**
   * Invoked when the user activates the notification. Never invoked after
   * `close()`, and not guaranteed to be invoked at all (the user may dismiss it,
   * or the OS may retire it silently).
   */
  readonly onClick?: () => void;
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's Notification class.
 */
export interface OsNotificationBoundary {
  /**
   * Whether the current platform can display notifications at all.
   *
   * False on a Linux box with no notification daemon, and in headless CI. A
   * caller should skip rather than treat it as an error.
   */
  isSupported(): boolean;

  /**
   * Show a notification.
   *
   * @param options - Content and click handler
   * @returns Handle for closing it, or null when notifications are unsupported
   */
  show(options: OsNotificationOptions): OsNotificationHandle | null;

  /**
   * Dismiss a previously shown notification. No-op for an unknown or
   * already-closed handle, so a caller never has to track liveness.
   *
   * @param handle - Handle returned by `show`
   */
  close(handle: OsNotificationHandle): void;

  /** Dismiss every notification this boundary still holds open. */
  closeAll(): void;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { Notification } from "electron";

/**
 * Default implementation of OsNotificationBoundary using Electron's Notification.
 */
export class DefaultOsNotificationBoundary implements OsNotificationBoundary {
  private readonly open = new Map<string, Notification>();
  private nextId = 1;

  constructor(private readonly logger: Logger) {}

  isSupported(): boolean {
    return Notification.isSupported();
  }

  show(options: OsNotificationOptions): OsNotificationHandle | null {
    if (!Notification.isSupported()) {
      this.logger.debug("OS notifications unsupported on this platform — skipping", {
        title: options.title,
      });
      return null;
    }

    const id = `os-notification-${this.nextId++}`;
    const notification = new Notification({
      title: options.title,
      body: options.body,
    });

    // Drop our reference on any terminal outcome, so `closeAll` never touches a
    // notification the OS already retired and the map cannot grow unbounded
    // across a long session.
    const forget = (): void => {
      this.open.delete(id);
    };
    notification.on("close", forget);
    notification.on("failed", forget);
    if (options.onClick) {
      const onClick = options.onClick;
      notification.on("click", () => {
        forget();
        onClick();
      });
    }

    this.open.set(id, notification);
    notification.show();
    this.logger.debug("OS notification shown", { id, title: options.title });

    return { id, __brand: "OsNotificationHandle" };
  }

  close(handle: OsNotificationHandle): void {
    const notification = this.open.get(handle.id);
    if (!notification) return;
    this.open.delete(handle.id);
    notification.close();
  }

  closeAll(): void {
    const count = this.open.size;
    for (const notification of this.open.values()) {
      notification.close();
    }
    this.open.clear();
    if (count > 0) {
      this.logger.debug("Closed outstanding OS notifications", { count });
    }
  }
}
