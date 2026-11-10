/**
 * The CodeHydra API the sidekick exports to other VS Code extensions
 * (`exports.codehydra`, declared for them in `../api.d.ts`).
 */
import type { CodehydraApi, WorkspaceCreateOptions } from "../api";
import { TAGS_METADATA_KEY_PREFIX, extractTags } from "../../../src/shared/api/types";
import type { WorkspaceTag } from "../../../src/shared/api/types";
import { emitApiCall, log, whenReady } from "./connection";
import type { AgentSession, WorkspaceCreateRequest, WorkspaceStatus } from "./types";

/** The metadata key a workspace tag is stored under. */
export function tagKey(name: string): string {
  return `${TAGS_METADATA_KEY_PREFIX}${name}`;
}

/**
 * CodeHydra API for VS Code extensions.
 * Provides access to workspace status and metadata.
 */
export const codehydraApi = {
  /**
   * Wait for the extension to be connected to CodeHydra.
   * Resolves immediately if already connected.
   */
  whenReady,

  /**
   * Log API namespace.
   * Provides structured logging to CodeHydra's logging system.
   * Methods are fire-and-forget and gracefully handle disconnected state.
   */
  log,

  /**
   * Workspace API namespace.
   * All methods require the connection to be established (use whenReady() first).
   */
  workspace: {
    getStatus(options?: { refresh?: boolean }) {
      return emitApiCall<WorkspaceStatus>(
        "api:workspace:getStatus",
        options !== undefined ? options : undefined
      );
    },

    getAgentSession() {
      return emitApiCall<AgentSession | null>("api:workspace:getAgentSession");
    },

    restartAgentServer() {
      return emitApiCall<number>("api:workspace:restartAgentServer");
    },

    getMetadata() {
      return emitApiCall<Record<string, string>>("api:workspace:getMetadata");
    },

    setMetadata(key: string, value: string | null) {
      return emitApiCall<void>("api:workspace:setMetadata", { key, value });
    },

    async getTags(): Promise<readonly WorkspaceTag[]> {
      const metadata = await emitApiCall<Record<string, string>>("api:workspace:getMetadata");
      return extractTags(metadata);
    },

    async setTag(
      name: string,
      options?: { color?: string; label?: string; description?: string }
    ): Promise<void> {
      // Full replace, matching workspace.tag.set: the stored object is exactly the
      // options this call passed, so an omitted field clears whatever was there.
      const tag: { color?: string; label?: string; description?: string } = {};
      if (options?.color !== undefined) tag.color = options.color;
      if (options?.label !== undefined) tag.label = options.label.trim();
      if (options?.description !== undefined) tag.description = options.description.trim();
      const value = JSON.stringify(tag);
      await emitApiCall<void>("api:workspace:setMetadata", { key: tagKey(name), value });
    },

    async deleteTag(name: string): Promise<void> {
      await emitApiCall<void>("api:workspace:setMetadata", { key: tagKey(name), value: null });
    },

    executeCommand(command: string, args?: readonly unknown[]) {
      // Client-side validation
      if (typeof command !== "string" || command.trim().length === 0) {
        return Promise.reject(new Error("Command must be a non-empty string"));
      }
      if (args !== undefined && !Array.isArray(args)) {
        return Promise.reject(new Error("Args must be an array"));
      }
      return emitApiCall<unknown>("api:workspace:executeCommand", { command, args });
    },

    create(name: string, options?: WorkspaceCreateOptions) {
      // Client-side validation
      if (typeof name !== "string" || name.trim().length === 0) {
        return Promise.reject(new Error("Name must be a non-empty string"));
      }
      // The base used to be the second argument; it is an option now, and only
      // a git project's. Say so instead of sending a string the server rejects
      // with a less helpful message.
      if (typeof (options as unknown) === "string") {
        return Promise.reject(
          new Error(
            "create(name, base) is gone: pass the base as an option, create(name, { base })"
          )
        );
      }
      if (options !== undefined && (typeof options !== "object" || options === null)) {
        return Promise.reject(new Error("Options must be an object"));
      }
      // Everything else — which options the project's type takes, and their
      // values — is checked by the server, as for `ch ws create`.
      const request: WorkspaceCreateRequest = { ...options, name };
      return emitApiCall("api:workspace:create", request);
    },
  },
  // `satisfies` ensures the implementation matches the public CodehydraApi contract
  // while preserving the literal types for internal use (better inference than `as`)
} satisfies CodehydraApi;
