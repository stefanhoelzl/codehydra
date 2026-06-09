/**
 * Notification framework types.
 * Shared between main, preload, and renderer processes.
 *
 * NOTE: This file must be browser-compatible (no Node.js imports).
 *
 * Notifications are lightweight, non-modal indicators displayed in the sidebar.
 * The backend sends the full config; a generic renderer displays it.
 */

import type { DialogButton } from "./dialog-types";

// ---- Notification Config ----

/**
 * Full notification configuration.
 *
 * - type "spinner": animated progress ring (for ongoing operations like cloning)
 * - type "info": informational (blue info icon)
 * - type "warning": warning (yellow warning triangle)
 * - type "error": error (red error circle)
 *
 * - progress (number 0-1): determinate progress bar
 * - progress (true): indeterminate progress bar
 * - progress (undefined): no progress bar
 */
export interface NotificationConfig {
  readonly title: string;
  readonly message?: string;
  readonly type: "info" | "warning" | "error" | "spinner";
  /** 0-1 for determinate, true for indeterminate, undefined for none */
  readonly progress?: number | true;
  /** When true, a dismiss button is shown */
  readonly dismissible?: boolean;
  /** Action buttons rendered below the notification content */
  readonly actions?: readonly DialogButton[];
}

// ---- IPC Protocol ----

/**
 * Commands sent from main -> renderer to manage notification lifecycle.
 */
export type NotificationCommand =
  | {
      readonly action: "open";
      readonly notificationId: string;
      readonly config: NotificationConfig;
    }
  | {
      readonly action: "update";
      readonly notificationId: string;
      readonly config: NotificationConfig;
    }
  | { readonly action: "close"; readonly notificationId: string };

/**
 * Events sent from renderer -> main when user interacts with a notification.
 */
export interface NotificationUserEvent {
  readonly notificationId: string;
  /** "dismiss" for the dismiss button, or a DialogButton.id for action buttons */
  readonly actionId: string;
}
