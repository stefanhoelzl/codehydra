// @vitest-environment node
/**
 * Integration tests for CloneNotificationModule.
 *
 * The interesting case is identity. NotificationManager collapses notifications
 * whose visible text matches, so a clone card titled with the repo's basename
 * would merge two clones of different URLs that happen to share one — and the
 * first to finish would close the card out from under the second. The card is
 * therefore titled with what the user typed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EVENT_CLONE_PROGRESS,
  EVENT_PROJECT_OPENED,
  type CloneProgressEvent,
  type ProjectOpenedEvent,
} from "../intents/open-project";
import { createCloneNotificationModule } from "./clone-notification-module";
import type { IntentModule } from "../intents/lib/module";
import {
  createMockNotificationManager,
  type MockNotificationManager,
} from "./presentation/notification-manager.state-mock";
import type { Project, ProjectId } from "../shared/api/types";
import { projPath } from "../shared/test-fixtures";

const A = "https://github.com/baltech-ag/Bros2FW";
const B = "https://github.com/someone-else/Bros2FW";

function progress(url: string, stage: string | null = null): CloneProgressEvent {
  return {
    type: EVENT_CLONE_PROGRESS,
    payload: { stage: stage ?? "", progress: 0, name: "Bros2FW", url },
  };
}

function opened(git: string): ProjectOpenedEvent {
  return {
    type: EVENT_PROJECT_OPENED,
    payload: {
      project: {
        id: "p1" as ProjectId,
        name: "Bros2FW",
        path: projPath("/projects/Bros2FW"),
        workspaces: [],
      } satisfies Project,
      git,
    },
  };
}

describe("CloneNotificationModule", () => {
  let notifications: MockNotificationManager;
  let module: IntentModule;

  beforeEach(() => {
    notifications = createMockNotificationManager();
    module = createCloneNotificationModule({ ui: notifications.ui });
  });

  const emit = async (event: CloneProgressEvent | ProjectOpenedEvent): Promise<void> => {
    await module.events![event.type]!.handler(event);
  };

  it("titles the card with the URL the user entered", async () => {
    await emit(progress(A));

    expect(notifications.lastNotification!.opened.title).toBe(`Cloning ${A}`);
  });

  it("keeps two clones sharing a repo basename on separate cards", async () => {
    await emit(progress(A));
    await emit(progress(B));

    expect(notifications.notifications).toHaveLength(2);
    expect(notifications.notifications.map((n) => n.opened.title)).toEqual([
      `Cloning ${A}`,
      `Cloning ${B}`,
    ]);
  });

  it("does not let one clone finishing close the other's card", async () => {
    await emit(progress(A));
    await emit(progress(B));

    await emit(opened(A));

    expect(notifications.notifications[0]!.closed).toBe(true);
    expect(notifications.notifications[1]!.closed).toBe(false);
  });

  it("updates the same card as a clone progresses", async () => {
    await emit(progress(A));
    await emit(progress(A, "receiving"));

    expect(notifications.notifications).toHaveLength(1);
    expect(notifications.lastNotification!.latestConfig.message).toBeDefined();
  });
});
