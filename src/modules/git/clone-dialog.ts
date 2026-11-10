/**
 * The "Clone from Git" sub-dialog: git's add-project button in the New
 * workspace form (`project:add` action `git-clone`).
 *
 * Asks for a repository URL, clones it through project:open with the progress
 * inline, and on a GitHub URL that cannot be cloned offers to create the
 * repository. Resolves with the opened project, or null when the user cancels
 * or leaves the clone to finish in the background (project:opened then lands
 * on its own).
 */

import type { DialogConfig, DialogSection } from "../../shared/dialog-types";
import type { Logger } from "../../boundaries/platform/logging";
import type { AppBoundary } from "../../boundaries/shell/app";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { Project } from "../../shared/api/types";
import { extractGitHubOwnerRepo, buildGitHubNewRepoUrl } from "../../shared/github-utils";
import { getErrorMessage } from "../../shared/error-utils";
import {
  INTENT_OPEN_PROJECT,
  type CloneProgressPayload,
  type OpenProjectIntent,
} from "../../intents/open-project";
import type { DialogHandle } from "../presentation/sessions";
import type { UiPresenter } from "../presentation/presentation-module";

/** The `project:add` action id of the clone button. */
export const CLONE_ACTION_ID = "git-clone";

const CLONE_FIELD_URL = "url";
const CLONE_ACTION_SUBMIT = "do-clone";
const CLONE_ACTION_CANCEL = "cancel";
const CLONE_ACTION_BACKGROUND = "background";
const CLONE_ACTION_GITHUB_CREATE = "github-create";
const CLONE_ACTION_RETRY = "retry";

/**
 * The line of a clone error worth showing: git's last output line (its
 * `fatal: …` reason), without the "Cloning into bare repository '<path>'"
 * progress line before it. Display only — it decides nothing; the full text
 * stays in the log.
 */
function cloneFailureReason(error: string): string {
  const lines = error
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1] ?? error;
}

/** Returns an error message for an invalid clone URL, or null when valid/empty. */
export function validateCloneUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Full URL formats (HTTPS, HTTP, SSH, git://, ssh://)
  if (/^https?:\/\/[^\s]+/.test(trimmed)) return null;
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s]+/.test(trimmed)) return null;
  if (/^git:\/\/[^\s]+/.test(trimmed)) return null;
  if (/^ssh:\/\/[^\s]+/.test(trimmed)) return null;
  // Shorthand: org/repo (GitHub shorthand - no dots in first segment)
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) return null;
  // Partial URL: github.com/org/repo (domain without protocol)
  if (/^[a-z0-9.-]+\/[^\s]+$/i.test(trimmed) && trimmed.includes(".")) return null;
  return "Enter a git URL, org/repo, or github.com/org/repo";
}

interface CloneViewState {
  url: string;
  /** The URL this dialog submitted (null = not cloning). */
  cloneUrl: string | null;
  error: string | null;
  /** Latest clone progress (from clone:progress events) while cloning. */
  progress: { stage: string; progress: number } | null;
}

function buildCloneConfig(state: CloneViewState): DialogConfig {
  const cloning = state.cloneUrl !== null;
  const validationError = validateCloneUrl(state.url);
  const gitHubInfo = state.error !== null ? extractGitHubOwnerRepo(state.url.trim()) : null;

  const sections: DialogSection[] = [
    { type: "text", content: "Clone from Git Repository", style: "heading" },
    {
      type: "input",
      id: CLONE_FIELD_URL,
      label: "Repository URL",
      placeholder: "org/repo or https://github.com/org/repo.git",
      // Immediate so the Clone button's enabled state can't lag behind the
      // typed URL when the user hits Enter right after typing.
      changeEvent: { debounceMs: 0 },
      disabled: cloning,
      autofocus: true,
      ...(validationError !== null && { error: validationError }),
    },
  ];

  if (cloning) {
    sections.push({
      type: "progress",
      items: [
        {
          id: "clone",
          label: "Cloning repository",
          status: "running",
          ...(state.progress !== null && {
            progress: state.progress.progress,
            message: state.progress.stage,
          }),
        },
      ],
    });
  }

  if (state.error !== null && gitHubInfo !== null) {
    // GitHub answers a missing repository and one the user's credentials
    // cannot read alike, so the dialog never claims which it is: it offers
    // both ways out (git's own reason is in the log).
    sections.push(
      {
        type: "text",
        content:
          "GitHub reports a missing repository and one your git credentials can't read " +
          "the same way. If the repository exists, check that git on this machine is " +
          "signed in with an account or token that can access it.",
        style: "subtitle",
      },
      { type: "text", content: "Repository doesn't exist yet?" },
      {
        type: "group",
        align: "left",
        items: [
          {
            type: "button",
            id: CLONE_ACTION_GITHUB_CREATE,
            label: "Create on GitHub",
            icon: "github",
          },
        ],
      },
      {
        type: "text",
        content: "Initialize it with a README so it can be cloned.",
        icon: "warning",
        style: "subtitle",
      }
    );
  } else if (state.error !== null) {
    sections.push({ type: "text", content: cloneFailureReason(state.error), icon: "error" });
  }

  const footer: DialogSection = cloning
    ? {
        type: "group",
        align: "right",
        // role "cancel": mid-clone, Escape detaches like this button.
        items: [
          {
            type: "button",
            id: CLONE_ACTION_BACKGROUND,
            label: "Continue in background",
            role: "cancel",
          },
        ],
      }
    : {
        // Tab order: input -> Clone -> Cancel; visually Cancel sits left of
        // the primary (reverse rendering).
        type: "group",
        align: "right",
        reverse: true,
        items: [
          gitHubInfo !== null
            ? { type: "button" as const, id: CLONE_ACTION_RETRY, label: "Retry Clone" }
            : {
                type: "button" as const,
                id: CLONE_ACTION_SUBMIT,
                label: "Clone",
                variant: "primary" as const,
                disabled: state.url.trim() === "" || validationError !== null,
              },
          {
            type: "button" as const,
            id: CLONE_ACTION_CANCEL,
            label: "Cancel",
            variant: "secondary" as const,
            role: "cancel" as const,
          },
        ],
      };
  sections.push(footer);

  return { sections, layout: "form" };
}

export interface CloneDialogDeps {
  readonly ui: Pick<UiPresenter, "dialog">;
  readonly dispatcher: Pick<Dispatcher, "dispatch">;
  readonly appBoundary: Pick<AppBoundary, "openUrl">;
  readonly logger: Logger;
}

export interface CloneDialog {
  /** Show the dialog; resolves when it closes (see the file comment). */
  run(): Promise<Project | null>;
  /** Feed a clone:progress event to the open dialog. */
  progress(payload: CloneProgressPayload): void;
}

export function createCloneDialog(deps: CloneDialogDeps): CloneDialog {
  const { ui, dispatcher, logger } = deps;

  interface CloneDialogState extends CloneViewState {
    readonly handle: DialogHandle;
    readonly done: (project: Project | null) => void;
  }

  let open: CloneDialogState | null = null;

  function update(): void {
    if (open === null) return;
    open.handle.update(buildCloneConfig(open));
  }

  function close(state: CloneDialogState, project: Project | null): void {
    if (open !== state) return;
    open = null;
    state.handle.close();
    state.done(project);
  }

  function startClone(state: CloneDialogState): void {
    const url = state.url.trim();
    if (url === "" || validateCloneUrl(url) !== null || state.cloneUrl !== null) return;
    state.error = null;
    state.cloneUrl = url;
    state.progress = null;
    update();
    logger.debug("Cloning repository", { url });

    const intent: OpenProjectIntent = {
      type: INTENT_OPEN_PROJECT,
      payload: { git: url, initial: true },
    };
    dispatcher.dispatch(intent).then(
      (project) => {
        // Only react if this dialog instance still owns the clone.
        if (open !== state || state.cloneUrl !== url) return;
        close(state, project);
      },
      (error: unknown) => {
        if (open !== state || state.cloneUrl !== url) return;
        state.error = getErrorMessage(error);
        state.cloneUrl = null;
        state.progress = null;
        logger.warn("Clone failed", { url, error: state.error });
        update();
      }
    );
  }

  return {
    run() {
      if (open !== null) return Promise.resolve(null);
      return new Promise<Project | null>((done) => {
        const initial: CloneViewState = { url: "", cloneUrl: null, error: null, progress: null };
        const handle = ui.dialog(buildCloneConfig(initial));
        const state: CloneDialogState = { ...initial, handle, done };
        open = state;

        handle.onChange((event) => {
          if (open !== state) return;
          if (event.fieldId === CLONE_FIELD_URL) {
            state.url = event.data[CLONE_FIELD_URL] ?? "";
            // Clear the submit error when the user types (mirrors the old dialog).
            if (state.error !== null) state.error = null;
            update();
          }
        });

        // Escape is declarative: the footer's cancel-role button (Cancel when
        // idle/error, "Continue in background" mid-clone) is clicked through the
        // action path below.
        handle.onEvent((event) => {
          if (open !== state) return;
          state.url = event.data?.[CLONE_FIELD_URL] ?? state.url;
          switch (event.actionId) {
            case CLONE_ACTION_SUBMIT:
              startClone(state);
              break;
            case CLONE_ACTION_RETRY:
              state.error = null;
              startClone(state);
              break;
            case CLONE_ACTION_BACKGROUND:
              // Detach: the clone keeps running; project:opened lands silently.
              logger.debug("Clone continuing in background", { url: state.cloneUrl });
              close(state, null);
              break;
            case CLONE_ACTION_CANCEL:
              if (state.cloneUrl === null) close(state, null);
              break;
            case CLONE_ACTION_GITHUB_CREATE: {
              const gitHubInfo = extractGitHubOwnerRepo(state.url.trim());
              if (gitHubInfo !== null) {
                const createUrl = buildGitHubNewRepoUrl(gitHubInfo.owner, gitHubInfo.repo);
                logger.info("Opening GitHub repo creation", { url: createUrl });
                void deps.appBoundary.openUrl(createUrl);
              }
              break;
            }
          }
        });
      });
    },

    progress(payload) {
      // Inline progress (the clone-notification module independently shows the
      // sidebar notification). The event carries progress 0-1; ProgressItem
      // expects 0-100.
      if (open === null || open.cloneUrl !== payload.url) return;
      open.progress = { stage: payload.stage, progress: Math.round(payload.progress * 100) };
      update();
    },
  };
}
