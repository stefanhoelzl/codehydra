/**
 * RemoteProjectModule - Handles remote (URL-cloned) project filesystem concerns.
 *
 * No internal state. No persistence. Delegates project state ownership to
 * LocalProjectModule. Responsible only for cloning repos on open and cleaning
 * up clone directories on close.
 *
 * Hook contributions:
 * - open-project / resolve: clone URL or return existing clone path
 * - close-project / close: filesystem cleanup (delete cloned directory if requested)
 */

import * as crypto from "node:crypto";
import nodePath from "path";
import type { IntentModule } from "../intents/infrastructure/module";
import type { HookContext } from "../intents/infrastructure/operation";
import type { IGitClient } from "../../services/git/git-client";
import type { PathProvider } from "../../services/platform/path-provider";
import type { FileSystemLayer } from "../../services/platform/filesystem";
import type { Logger } from "../../services/logging";
import { Path } from "../../services/platform/path";
import type { ProjectId } from "../../shared/api/types";
import { expandGitUrl, normalizeGitUrl, extractRepoName } from "../../services/project/url-utils";
import type { OpenProjectIntent, ResolveHookResult } from "../operations/open-project";
import { OPEN_PROJECT_OPERATION_ID } from "../operations/open-project";
import type { CloseHookInput, CloseHookResult } from "../operations/close-project";
import { CLOSE_PROJECT_OPERATION_ID } from "../operations/close-project";

// =============================================================================
// Private Helpers
// =============================================================================

function generateProjectIdFromUrl(url: string): ProjectId {
  const normalized = normalizeGitUrl(url);
  const repoName = extractRepoName(url);

  const safeName =
    repoName
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "repo";

  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);

  return `${safeName}-${hash}` as ProjectId;
}

// =============================================================================
// Factory
// =============================================================================

export function createRemoteProjectModule(deps: {
  readonly fs: Pick<FileSystemLayer, "readdir" | "rm">;
  readonly gitClient: Pick<IGitClient, "clone">;
  readonly pathProvider: Pick<PathProvider, "remotesDir">;
  readonly logger: Logger;
}): IntentModule {
  const { fs, gitClient, pathProvider, logger } = deps;

  return {
    hooks: {
      // -----------------------------------------------------------------------
      // open-project
      // -----------------------------------------------------------------------
      [OPEN_PROJECT_OPERATION_ID]: {
        resolve: {
          handler: async (ctx: HookContext): Promise<ResolveHookResult | undefined> => {
            const intent = ctx.intent as OpenProjectIntent;
            const { git } = intent.payload;

            if (!git) {
              return undefined;
            }

            const expanded = expandGitUrl(git);

            // Deterministic clone path from URL
            const urlProjectId = generateProjectIdFromUrl(expanded);
            const repoName = extractRepoName(expanded);
            const projectDir = new Path(pathProvider.remotesDir.toString(), urlProjectId);
            const gitPath = new Path(projectDir.toString(), repoName);

            // Check for existing clone via filesystem
            try {
              await fs.readdir(gitPath.toString());

              logger.debug("Found existing project for URL", {
                url: expanded,
                existingPath: gitPath.toString(),
              });
              return {
                projectPath: gitPath.toString(),
                remoteUrl: expanded,
              };
            } catch {
              // Not found — clone
            }

            logger.debug("Cloning repository", {
              url: expanded,
              gitPath: gitPath.toString(),
            });

            await gitClient.clone(expanded, gitPath);

            // No saveProject call — LocalProjectModule.register handles persistence
            // with remoteUrl from context

            return { projectPath: gitPath.toString(), remoteUrl: expanded };
          },
        },
      },

      // -----------------------------------------------------------------------
      // close-project
      // -----------------------------------------------------------------------
      [CLOSE_PROJECT_OPERATION_ID]: {
        // close: filesystem cleanup only — delete cloned directory if requested
        // Uses remoteUrl from hook context (provided by resolve-project results)
        close: {
          handler: async (ctx: HookContext): Promise<CloseHookResult> => {
            const { projectPath, removeLocalRepo, remoteUrl } = ctx as CloseHookInput;

            if (!removeLocalRepo || !remoteUrl) {
              return {};
            }

            // Delete the clone directory (parent of gitPath, e.g. remotes/<url-hash>/)
            const cloneDir = nodePath.dirname(new Path(projectPath).toString());
            await fs.rm(cloneDir, { recursive: true, force: true });

            return {};
          },
        },
      },
    },
  };
}
