/**
 * AutoTaggingModule — stamps a "new" tag on freshly created workspaces and clears
 * it the first time the user switches to one.
 *
 * The tag marks a workspace as unseen; switching to it is what "seeing" means.
 * Every fresh creation gets it, not just agent-driven ones: a creation the user
 * confirmed and then navigated away from is just as unvisited, and since a
 * completing creation no longer steals the view back (open-workspace.ts), the tag
 * is the only signal that it finished. One the user does land on has its tag
 * cleared by that same landing switch, so it is never seen there.
 *
 * Fresh creation = no `existingWorkspace`. That guard matters: waking a hibernated
 * workspace and re-discovering worktrees on startup both re-run workspace:open,
 * and neither is a new workspace.
 *
 * The tag is written from the "setup" hook rather than a workspace:created subscriber
 * so it rides along in the metadata the created event carries (see the setup fold in
 * open-workspace.ts) — that lands it on the row's first paint, and since setup is
 * awaited before the operation's switch dispatch, it also can't race the removal below.
 *
 * `auto-tag.new` gates tagging only. Removal always runs, so turning the feature off
 * can never strand a tag the user has no way to clear.
 */

import { getErrorMessage } from "../shared/error-utils";
import type { WorkspaceRef } from "../intents/contract";
import type { IntentModule } from "../intents/lib/module";
import type { HookOutput } from "../intents/lib/operation";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { Config } from "../boundaries/platform/config";
import { storeBoolean } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_CREATED,
  type SetupHookResult,
} from "../intents/open-workspace";
import {
  INTENT_SET_METADATA,
  EVENT_METADATA_CHANGED,
  type SetMetadataIntent,
} from "../intents/set-metadata";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import { encodeTag, tagKey } from "../shared/api/types";
import { defineEvents, defineHooks } from "../intents/declarations";

/** Metadata key holding the tag. `tags.`-prefixed keys are what the UI renders as tags. */
const NEW_TAG_KEY = tagKey("new");
/** Blue reads as informational/unseen, leaving red (deletion-failed) the only alarm color. */
const NEW_TAG_VALUE = encodeTag({ color: "#3498db" });

export interface AutoTaggingModuleDeps {
  readonly dispatcher: Dispatcher;
  readonly configService: Config;
  readonly logger: Logger;
}

export function createAutoTaggingModule(deps: AutoTaggingModuleDeps): IntentModule {
  const newTagConfig = deps.configService.register("auto-tag.new", {
    default: true,
    description: 'Tag newly created workspaces with "new" until first switched to',
    applies: "live",
    ...storeBoolean(),
  });

  // Workspaces currently carrying the tag. Lets a switch skip the git write for
  // the workspaces that aren't tagged — which is nearly all of them, on a path that
  // has to stay snappy (keyboard nav switches on every arrow key).
  const tagged = new Set<WorkspaceRef>();

  return {
    name: "auto-tagging",
    hooks: defineHooks({
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx): Promise<HookOutput<SetupHookResult>> => {
            const { workspaceRef, fresh } = ctx;
            if (!fresh || !newTagConfig.get()) return {};

            try {
              await deps.dispatcher.dispatch<SetMetadataIntent>({
                type: INTENT_SET_METADATA,
                payload: { workspaceRef, key: NEW_TAG_KEY, value: NEW_TAG_VALUE },
              });
            } catch (error) {
              // Cosmetic — never fail a workspace creation over a tag.
              deps.logger
                .scoped({ workspace: workspaceRef })
                .warn("Failed to tag background workspace", {
                  error: getErrorMessage(error),
                });
              return {};
            }

            tagged.add(workspaceRef);
            return { result: { metadata: { [NEW_TAG_KEY]: NEW_TAG_VALUE } } };
          },
        },
      },
    }),
    events: defineEvents({
      // Re-seeds the set from stored metadata on startup, so a tag written in an earlier
      // run still clears on the next switch rather than sticking forever.
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event): Promise<void> => {
          const { workspaceRef, metadata } = event.payload;
          if (metadata[NEW_TAG_KEY] !== undefined) tagged.add(workspaceRef);
        },
      },
      // Keeps the set honest when the tag is added or removed out from under us
      // (sidekick, MCP, or our own writes below).
      [EVENT_METADATA_CHANGED]: {
        handler: async (event): Promise<void> => {
          const { workspaceRef, key, value } = event.payload;
          if (key !== NEW_TAG_KEY) return;
          if (value === null) tagged.delete(workspaceRef);
          else tagged.add(workspaceRef);
        },
      },
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event): Promise<void> => {
          // Payload is null when the user deselects (creation panel becomes the view).
          const payload = event.payload as WorkspaceSwitchedEvent["payload"] | null;
          if (payload === null) return;
          if (!tagged.has(payload.workspaceRef)) return;

          try {
            await deps.dispatcher.dispatch<SetMetadataIntent>({
              type: INTENT_SET_METADATA,
              payload: { workspaceRef: payload.workspaceRef, key: NEW_TAG_KEY, value: null },
            });
          } catch (error) {
            // Leave it in the set — the next switch retries.
            deps.logger
              .scoped({ workspace: payload.workspaceRef })
              .warn("Failed to clear new tag", {
                error: getErrorMessage(error),
              });
          }
        },
      },
    }),
  };
}
