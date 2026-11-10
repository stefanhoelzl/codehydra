// @vitest-environment node
/**
 * Integration tests for git's "Clone from Git" dialog (behavioral mocks): URL
 * validation, cloning through project:open with inline progress, the GitHub
 * create-on-error flow, and how the dialog ends — the opened project, or null.
 */

import { describe, it, expect, vi } from "vitest";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockDialogManager } from "../presentation/dialog-manager.state-mock";
import type { Dispatcher } from "../../intents/lib/dispatcher";
import type { DialogConfig, DialogSection } from "../../shared/dialog-types";
import type { Project, ProjectId } from "../../shared/api/types";
import { INTENT_OPEN_PROJECT, type CloneProgressPayload } from "../../intents/open-project";
import { projPath, testPath } from "../../shared/test-fixtures";
import { gitProjectRef } from "./ref";
import { createCloneDialog, validateCloneUrl } from "./clone-dialog";

const PROJECT_B: Project = {
  ref: gitProjectRef(projPath("/projects/b")),
  id: "project-b-12345678" as ProjectId,
  name: "project-b",
  path: projPath("/projects/b"),
  workspaces: [],
};

function sectionById(config: DialogConfig, id: string): DialogSection | undefined {
  for (const section of config.sections) {
    if ("id" in section && section.id === id) return section;
    if (section.type === "group") {
      for (const item of section.items) {
        if (item.id === id) return item as unknown as DialogSection;
      }
    }
  }
  return undefined;
}

function field(config: DialogConfig, id: string): Record<string, unknown> {
  const section = sectionById(config, id);
  expect(section, `section "${id}"`).toBeDefined();
  return section as unknown as Record<string, unknown>;
}

/** The footer's cancel-role button (the one Escape clicks), or undefined. */
function cancelButton(config: DialogConfig): { id: string } | undefined {
  for (const section of config.sections) {
    if (section.type !== "group") continue;
    for (const item of section.items) {
      if (item.type === "button" && item.role === "cancel") return item;
    }
  }
  return undefined;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function setup() {
  const dialogs = createMockDialogManager();
  const dispatched: Array<{ type: string; payload: unknown }> = [];
  const results = new Map<string, (payload: unknown) => unknown>();
  const dispatcher = {
    dispatch: vi.fn((intent: { type: string; payload: unknown }) => {
      dispatched.push(intent);
      const handler = results.get(intent.type);
      return Promise.resolve(handler ? handler(intent.payload) : undefined);
    }),
  } as unknown as Dispatcher;
  const openUrl = vi.fn().mockResolvedValue(undefined);
  const dialog = createCloneDialog({
    ui: dialogs.ui,
    dispatcher,
    appBoundary: { openUrl },
    logger: SILENT_LOGGER,
  });
  return {
    dialogs,
    openUrl,
    dispatcher: {
      results,
      byType: (type: string) => dispatched.filter((d) => d.type === type),
    },
    /** Open the dialog, as the clone button does. Resolves when it closes. */
    run: (): Promise<Project | null> => dialog.run(),
    progress: (payload: CloneProgressPayload): void => dialog.progress(payload),
  };
}

describe("clone dialog", () => {
  it("opens a modal dialog with URL validation gating the Clone button", async () => {
    const s = setup();
    void s.run();
    await flush();

    const clone = s.dialogs.modalHandles()[0]!;
    expect(clone.kind).toBe("modal");
    expect(field(clone.config, "do-clone")["disabled"]).toBe(true);

    clone.emitChange("url", { url: "not a url" });
    await flush();
    expect(field(clone.config, "url")["error"]).toMatch(/git URL/);
    expect(field(clone.config, "do-clone")["disabled"]).toBe(true);

    clone.emitChange("url", { url: "org/repo" });
    await flush();
    expect(field(clone.config, "url")["error"]).toBeUndefined();
    expect(field(clone.config, "do-clone")["disabled"]).toBe(false);
  });

  it("clones via project:open {git} and selects the project on success", async () => {
    const s = setup();
    const run = s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;

    let resolveClone: (value: Project) => void = () => {};
    s.dispatcher.results.set(
      INTENT_OPEN_PROJECT,
      () => new Promise<Project>((resolve) => (resolveClone = resolve))
    );

    clone.emitChange("url", { url: "org/repo" });
    await flush();
    clone.emitAction("do-clone", { url: "org/repo" });
    await flush();

    // Cloning: URL locked, footer switches to Continue in background.
    expect(field(clone.config, "url")["disabled"]).toBe(true);
    expect(sectionById(clone.config, "background")).toBeDefined();
    expect(sectionById(clone.config, "cancel")).toBeUndefined();
    expect(s.dispatcher.byType(INTENT_OPEN_PROJECT)[0]!.payload).toEqual({
      git: "org/repo",
      initial: true,
    });

    resolveClone(PROJECT_B);
    await flush();
    await flush();

    expect(clone.closed).toBe(true);
    await expect(run).resolves.toEqual(PROJECT_B);
  });

  it("shows the GitHub create-on-error flow for a GitHub-shaped URL", async () => {
    const s = setup();
    void s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;
    s.dispatcher.results.set(INTENT_OPEN_PROJECT, () =>
      Promise.reject(new Error("repository not found"))
    );

    clone.emitChange("url", { url: "org/repo" });
    await flush();
    clone.emitAction("do-clone", { url: "org/repo" });
    await flush();
    await flush();

    expect(sectionById(clone.config, "github-create")).toBeDefined();
    expect(sectionById(clone.config, "retry")).toBeDefined();

    clone.emitAction("github-create", { url: "org/repo" });
    await flush();
    expect(s.openUrl).toHaveBeenCalledWith("https://github.com/new?owner=org&name=repo");
  });

  it("does not claim a failed GitHub clone is missing", async () => {
    // A private repository the user's credentials cannot read fails with a
    // 403 — GitHub answers it like a missing one, so the dialog must not
    // say "not found" and must point at the credentials.
    const s = setup();
    void s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;
    s.dispatcher.results.set(INTENT_OPEN_PROJECT, () =>
      Promise.reject(
        new Error(
          "Failed to clone repository from https://github.com/org/repo: " +
            "Cloning into bare repository 'c:\\remotes\\repo-1\\repo'...\n" +
            "fatal: unable to access 'https://github.com/org/repo/': " +
            "The requested URL returned error: 403\n"
        )
      )
    );

    clone.emitChange("url", { url: "https://github.com/org/repo" });
    await flush();
    clone.emitAction("do-clone", { url: "https://github.com/org/repo" });
    await flush();
    await flush();

    const texts = clone.config.sections.flatMap((sec) =>
      sec.type === "text" ? [sec.content] : []
    );
    expect(texts.some((t) => t.includes("not found"))).toBe(false);
    expect(texts.some((t) => t.includes("git credentials"))).toBe(true);
    expect(sectionById(clone.config, "github-create")).toBeDefined();
  });

  it("shows a plain error (no GitHub flow) for non-GitHub URLs", async () => {
    const s = setup();
    void s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;
    s.dispatcher.results.set(INTENT_OPEN_PROJECT, () =>
      Promise.reject(new Error("connection refused"))
    );

    clone.emitChange("url", { url: "https://gitlab.example.com/org/repo.git" });
    await flush();
    clone.emitAction("do-clone", { url: "https://gitlab.example.com/org/repo.git" });
    await flush();
    await flush();

    expect(sectionById(clone.config, "github-create")).toBeUndefined();
    const errorSection = clone.config.sections.find(
      (sec) => sec.type === "text" && sec.icon === "error"
    );
    expect(errorSection).toMatchObject({ content: "connection refused" });
  });

  it("shows inline clone progress from clone:progress events", async () => {
    const s = setup();
    void s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;
    s.dispatcher.results.set(INTENT_OPEN_PROJECT, () => new Promise<Project>(() => {}));

    clone.emitChange("url", { url: "org/repo" });
    await flush();
    clone.emitAction("do-clone", { url: "org/repo" });
    await flush();

    // Cloning with no progress yet: indeterminate running item.
    const progressSection = (): Record<string, unknown> | undefined =>
      clone.config.sections.find((sec) => sec.type === "progress") as unknown as
        Record<string, unknown> | undefined;
    expect(progressSection()).toBeDefined();
    expect((progressSection()!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: "running",
    });

    // The event carries 0-1; the progress item is scaled to 0-100.
    s.progress({
      stage: "Receiving objects",
      progress: 0.42,
      name: "repo",
      url: "org/repo",
    });
    expect((progressSection()!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      progress: 42,
      message: "Receiving objects",
    });

    // Progress for a different URL is ignored.
    s.progress({
      stage: "other",
      progress: 0.99,
      name: "other",
      url: "other/repo",
    });
    expect((progressSection()!["items"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      progress: 42,
    });
  });

  it("'Continue in background' closes the dialog; the clone result lands silently", async () => {
    const s = setup();
    const run = s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;

    let resolveClone: (value: Project) => void = () => {};
    s.dispatcher.results.set(
      INTENT_OPEN_PROJECT,
      () => new Promise<Project>((resolve) => (resolveClone = resolve))
    );
    clone.emitChange("url", { url: "org/repo" });
    await flush();
    clone.emitAction("do-clone", { url: "org/repo" });
    await flush();

    clone.emitAction("background", {});
    await flush();
    expect(clone.closed).toBe(true);

    // The detached clone completing must NOT hijack the form selection.
    resolveClone(PROJECT_B);
    await flush();
    await flush();
    await expect(run).resolves.toBeNull();
  });

  it("Cancel closes the dialog when not cloning", async () => {
    const s = setup();
    void s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;

    clone.emitAction("cancel", {});
    await flush();
    expect(clone.closed).toBe(true);
  });

  it("Cancel carries role 'cancel' when not cloning, so Escape clicks it", async () => {
    const s = setup();
    void s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;

    // The cancel-role marker is what makes the form route Escape to Cancel.
    expect(cancelButton(clone.config)?.id).toBe("cancel");

    clone.emitAction("cancel", {});
    await flush();
    expect(clone.closed).toBe(true);
  });

  it("Cancel carries role 'cancel' after a failed clone", async () => {
    const s = setup();
    void s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;
    s.dispatcher.results.set(INTENT_OPEN_PROJECT, () => Promise.reject(new Error("nope")));

    clone.emitChange("url", { url: "org/repo" });
    await flush();
    clone.emitAction("do-clone", { url: "org/repo" });
    await flush();
    await flush();

    expect(cancelButton(clone.config)?.id).toBe("cancel");

    clone.emitAction("cancel", {});
    await flush();
    expect(clone.closed).toBe(true);
  });

  it("mid-clone, 'Continue in background' is the cancel-role button (Escape detaches)", async () => {
    const s = setup();
    const run = s.run();
    await flush();
    const clone = s.dialogs.modalHandles()[0]!;

    let resolveClone: (value: Project) => void = () => {};
    s.dispatcher.results.set(
      INTENT_OPEN_PROJECT,
      () => new Promise<Project>((resolve) => (resolveClone = resolve))
    );
    clone.emitChange("url", { url: "org/repo" });
    await flush();
    clone.emitAction("do-clone", { url: "org/repo" });
    await flush();

    // Mid-clone, Escape maps to the only footer button — "Continue in background".
    expect(cancelButton(clone.config)?.id).toBe("background");

    clone.emitAction("background", {});
    await flush();
    expect(clone.closed).toBe(true);

    // The detached clone completing must NOT hijack the form selection.
    resolveClone(PROJECT_B);
    await flush();
    await flush();
    await expect(run).resolves.toBeNull();
  });
});

describe("validateCloneUrl", () => {
  it.each([
    "https://github.com/org/repo.git",
    "http://example.com/repo",
    "git@github.com:org/repo.git",
    "git://example.com/repo.git",
    "ssh://git@example.com/repo.git",
    "org/repo",
    "github.com/org/repo",
    "",
    "   ",
  ])("accepts %j", (url) => {
    expect(validateCloneUrl(url)).toBeNull();
  });

  it.each(["not a url", "just-words", testPath("/absolute/path").toNative()])(
    "rejects %j",
    (url) => {
      expect(validateCloneUrl(url)).not.toBeNull();
    }
  );
});
