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
 * so it rides along in the metadata the created event carries (see mergeMetadata in
 * open-workspace.ts) — that lands it on the row's first paint, and since setup is
 * awaited before the operation's switch dispatch, it also can't race the removal below.
 *
 * `auto-tag.new` gates tagging only. Removal always runs, so turning the feature off
 * can never strand a tag the user has no way to clear.
 */

import type { IntentModule } from "../intents/lib/module";
import type { DomainEvent } from "../intents/lib/types";
import type { HookContext, HookOutput } from "../intents/lib/operation";
import type { Dispatcher } from "../intents/lib/dispatcher";
import type { Config } from "../boundaries/platform/config";
import { storeBoolean } from "../boundaries/platform/store-definition";
import type { Logger } from "../boundaries/platform/logging";
import {
  OPEN_WORKSPACE_OPERATION_ID,
  EVENT_WORKSPACE_CREATED,
  type OpenWorkspaceIntent,
  type SetupHookInput,
  type SetupHookResult,
  type WorkspaceCreatedEvent,
} from "../intents/open-workspace";
import {
  INTENT_SET_METADATA,
  EVENT_METADATA_CHANGED,
  type SetMetadataIntent,
  type MetadataChangedEvent,
} from "../intents/set-metadata";
import { EVENT_WORKSPACE_SWITCHED, type WorkspaceSwitchedEvent } from "../intents/switch-workspace";
import { TAGS_METADATA_KEY_PREFIX } from "../shared/api/types";

/** Metadata key holding the tag. `tags.`-prefixed keys are what the UI renders as tags. */
const NEW_TAG_KEY = `${TAGS_METADATA_KEY_PREFIX}new`;
/** Blue reads as informational/unseen, leaving red (deletion-failed) the only alarm color. */
const NEW_TAG_VALUE = JSON.stringify({ color: "#3498db" });

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

  // Workspace paths currently carrying the tag. Lets a switch skip the git write for
  // the workspaces that aren't tagged — which is nearly all of them, on a path that
  // has to stay snappy (keyboard nav switches on every arrow key).
  const tagged = new Set<string>();

  return {
    name: "auto-tagging",
    hooks: {
      [OPEN_WORKSPACE_OPERATION_ID]: {
        setup: {
          handler: async (ctx: HookContext): Promise<HookOutput<SetupHookResult>> => {
            const { payload } = ctx.intent as OpenWorkspaceIntent;
            const isFreshCreate = payload.existingWorkspace === undefined;
            if (!isFreshCreate || !newTagConfig.get()) return {};

            const { workspacePath } = ctx as SetupHookInput;
            try {
              await deps.dispatcher.dispatch<SetMetadataIntent>({
                type: INTENT_SET_METADATA,
                payload: { workspacePath, key: NEW_TAG_KEY, value: NEW_TAG_VALUE },
              });
            } catch (error) {
              // Cosmetic — never fail a workspace creation over a tag.
              deps.logger.warn("Failed to tag background workspace", {
                workspacePath,
                error: error instanceof Error ? error.message : String(error),
              });
              return {};
            }

            tagged.add(workspacePath);
            return { result: { metadata: { [NEW_TAG_KEY]: NEW_TAG_VALUE } } };
          },
        },
      },
    },
    events: {
      // Re-seeds the set from git config on startup, so a tag written in an earlier
      // run still clears on the next switch rather than sticking forever.
      [EVENT_WORKSPACE_CREATED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath, metadata } = (event as WorkspaceCreatedEvent).payload;
          if (metadata[NEW_TAG_KEY] !== undefined) tagged.add(workspacePath);
        },
      },
      // Keeps the set honest when the tag is added or removed out from under us
      // (sidekick, MCP, or our own writes below).
      [EVENT_METADATA_CHANGED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          const { workspacePath, key, value } = (event as MetadataChangedEvent).payload;
          if (key !== NEW_TAG_KEY) return;
          if (value === null) tagged.delete(workspacePath);
          else tagged.add(workspacePath);
        },
      },
      [EVENT_WORKSPACE_SWITCHED]: {
        handler: async (event: DomainEvent): Promise<void> => {
          // Payload is null when the user deselects (creation panel becomes the view).
          const payload = (event as WorkspaceSwitchedEvent).payload as
            | WorkspaceSwitchedEvent["payload"]
            | null;
          if (payload === null) return;
          if (!tagged.has(payload.path)) return;

          try {
            await deps.dispatcher.dispatch<SetMetadataIntent>({
              type: INTENT_SET_METADATA,
              payload: { workspacePath: payload.path, key: NEW_TAG_KEY, value: null },
            });
          } catch (error) {
            // Leave it in the set — the next switch retries.
            deps.logger.warn("Failed to clear new tag", {
              workspacePath: payload.path,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
    },
  };
}
