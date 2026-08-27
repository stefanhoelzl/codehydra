/**
 * App-global registry entries — operations that do not act on a workspace.
 *
 * These are the reason CLI clients may connect without a workspace at all: they
 * are exactly what someone runs from a shell that is not inside a worktree.
 */

import { z } from "zod/v4";
import { defineEntry } from "../types";
import type { AnyOperationEntry } from "../types";
import type { EntryDeps } from "./deps";
import type { Logger, LogContext } from "../../boundaries/platform/logging";
import { logAtLevel } from "../../boundaries/platform/logging";
import type { LogLevel } from "../../boundaries/platform/logging-types";

import { ApiError } from "../errors";
import { projectPathSchema } from "../../intents/contract";
import { resolveProjectReference, type ProjectLocation } from "../workspace-lookup";
import { looksLikeGitUrl, resolveLocalPath } from "../../utils/project-reference";

import { INTENT_OPEN_PROJECT } from "../../intents/open-project";
import type { OpenProjectIntent } from "../../intents/open-project";
import { INTENT_CLOSE_PROJECT } from "../../intents/close-project";
import type { CloseProjectIntent } from "../../intents/close-project";
import { INTENT_LIST_PROJECTS } from "../../intents/list-projects";
import type { ListProjectsIntent } from "../../intents/list-projects";
import { INTENT_SUBMIT_BUG_REPORT } from "../../intents/submit-bug-report";
import type { SubmitBugReportIntent } from "../../intents/submit-bug-report";

export function appEntries(deps: EntryDeps, logger: Logger): readonly AnyOperationEntry[] {
  const { dispatcher } = deps;

  const projectList = defineEntry({
    name: "project.list",
    kind: "command",
    description: "List all open projects with their workspaces.",
    instructions:
      "Call this to discover projectPath values before creating a workspace in another project.",
    input: z.object({}),
    requiresWorkspace: false,
    handler: async () => {
      const result = await dispatcher.dispatch<ListProjectsIntent>({
        type: INTENT_LIST_PROJECTS,
        payload: {} as Record<string, never>,
      });
      if (!result) throw new Error("List projects returned no result");
      return result;
    },
  });

  const openProject = defineEntry({
    name: "project.open",
    kind: "command",
    description: "Open a project from a local path or a git URL.",
    instructions:
      "A local path is opened in place; a git URL or 'org/repo' shorthand is cloned first. " +
      "Which one is meant is inferred from the target, and --git forces the clone reading for " +
      "the rare target that reads as both. A relative path is resolved against the caller's " +
      "working directory, so '.' opens the repository you are standing in.",
    input: z.object({
      target: z.string().min(1).describe("Local path, git URL, or 'org/repo' shorthand"),
      git: z
        .boolean()
        .optional()
        .default(false)
        .describe("Treat the target as a git URL even if it reads as a path"),
    }),
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      const asGit = input.git || looksLikeGitUrl(input.target);

      const payload = asGit
        ? { git: input.target }
        : // Resolved here rather than by the caller: only the app knows whether
          // the path it ends up with is a project it can open, and reporting a
          // bad absolute path is clearer than reporting a bad relative one.
          { path: projectPathSchema.parse(resolveLocalPath(input.target, ctx.cwd)) };

      const project = await dispatcher.dispatch<OpenProjectIntent>({
        type: INTENT_OPEN_PROJECT,
        payload,
      });
      // Null means the folder dialog was cancelled, which a programmatic caller
      // never sees — it always names a target.
      if (!project) throw new Error("Open project returned no result");
      return project;
    },
  });

  const closeProject = defineEntry({
    name: "project.close",
    kind: "command",
    description: "Close a project and tear down its workspaces.",
    instructions:
      "Closing releases the project's workspaces at runtime; it does not delete their worktrees. " +
      "Accepts a project name or path. Pass removeLocalRepo to also delete the clone of a " +
      "project that was cloned from a URL.",
    input: z.object({
      project: z.string().min(1).describe("Project name or path to close"),
      removeLocalRepo: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also delete the local clone of a project cloned from a URL"),
    }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      const projects = await dispatcher.dispatch<ListProjectsIntent>({
        type: INTENT_LIST_PROJECTS,
        payload: {} as Record<string, never>,
      });
      const resolved = resolveProjectReference(
        (projects ?? []) as readonly ProjectLocation[],
        input.project
      );
      if ("error" in resolved) throw new ApiError("usage", resolved.error);

      await dispatcher.dispatch<CloseProjectIntent>({
        type: INTENT_CLOSE_PROJECT,
        payload: {
          projectPath: projectPathSchema.parse(resolved.path),
          removeLocalRepo: input.removeLocalRepo,
          // Never interactive: a programmatic caller must not be parked on a
          // confirmation dialog nobody is watching.
        },
      });
      return { closed: true };
    },
  });

  const log = defineEntry({
    name: "log",
    kind: "command",
    description: "Send a log message to CodeHydra's logging system.",
    instructions: "Messages appear with the [mcp] scope, tagged with the calling workspace.",
    input: z.object({
      level: z.enum(["silly", "debug", "info", "warn", "error"]),
      message: z.string().min(1),
      context: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Structured context (primitives only)"),
    }),
    // Callable from anywhere: a log line from outside a workspace is still a
    // log line, just without the workspace tag.
    requiresWorkspace: false,
    handler: async (ctx, input) => {
      const context: LogContext = {
        ...(input.context ?? {}),
        ...(ctx.workspacePath !== null && { workspace: ctx.workspacePath }),
      };
      logAtLevel(logger, input.level as LogLevel, input.message, context);
      return null;
    },
  });

  const reportIssue = defineEntry({
    name: "report.issue",
    kind: "command",
    description: "File a bug report about CodeHydra itself with its maintainers.",
    instructions:
      "Only use this when the user explicitly asks to report a bug or send feedback about " +
      "CodeHydra — never proactively, and never for a bug in the user's own project. Sends the " +
      "description together with CodeHydra's current logs and redacted configuration, and is " +
      "sent even when telemetry is disabled.",
    input: z.object({
      description: z.string().trim().min(1).describe("Description of the bug or feedback"),
    }),
    requiresWorkspace: false,
    handler: async (_ctx, input) => {
      await dispatcher.dispatch<SubmitBugReportIntent>({
        type: INTENT_SUBMIT_BUG_REPORT,
        payload: { description: input.description },
      });
      return { submitted: true };
    },
  });

  return [projectList, openProject, closeProject, log, reportIssue];
}
