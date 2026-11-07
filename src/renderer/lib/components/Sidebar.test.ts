/**
 * Tests for the Sidebar component: the rendering rules of the redesigned
 * sidebar (project cards, hibernated and automated lists, questions in rows,
 * Find) and the ui:events its gestures emit. Main owns the state the gestures
 * change, so the tests re-render with the snapshot main would push next.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, fireEvent } from "@testing-library/svelte";
import { flushSync } from "svelte";
import type { Api } from "@shared/electron-api";
import type {
  ProcessBarLevel,
  ProcessSummaryMode,
  UiNotification,
  UiProcessNode,
  UiProcessTotals,
  UiProcessTree,
  UiProjectRow,
} from "@shared/ui-state";
import { createMockApi, makeUiWorkspaceRow } from "../test-utils";
import { NOW, question, sampleProjects } from "./sidebar-fixture";

const mockApi: Api = createMockApi();
window.api = mockApi;
vi.mock("$lib/api");

import { emitEvent, sendNotificationEvent } from "$lib/api";
import Sidebar from "./Sidebar.svelte";

type Props = {
  projects: readonly UiProjectRow[];
  notifications?: readonly UiNotification[];
  find?: { hibernatedView: "hidden" | "manual" | "all" } | null;
  sidebarMode?: "overlay" | "docked";
  mode?: "workspace" | "hover" | "shortcut" | "dialog";
  shortcutModeActive?: boolean;
  processSummary?: ProcessSummaryMode;
  processLevel?: ProcessBarLevel;
  processTree?: UiProcessTree;
  processTreeHeight?: number;
  processTotals?: UiProcessTotals;
};

function setup(props: Props) {
  const all = { sidebarWidth: 288, notifications: [], sidebarMode: "docked" as const, ...props };
  const result = render(Sidebar, { props: all });
  const rerender = (next: Partial<Props>): void => {
    Object.assign(all, next);
    void result.rerender(all);
    flushSync();
  };
  return { ...result, rerender };
}

const card = (container: Element, id: string): Element => {
  const el = container.querySelector(`.proj[data-project-id="${id}"]`);
  if (el === null) throw new Error(`no card ${id}`);
  return el;
};
const row = (container: Element, key: string): Element => {
  const el = container.querySelector(`.ws[data-key="${key}"]`);
  if (el === null) throw new Error(`no row ${key}`);
  return el;
};
/** The row's fold is open (it is part of the list). */
const rowOpen = (container: Element, key: string): boolean =>
  row(container, key).closest(".cl")?.classList.contains("open") ?? false;
const hibGroupOpen = (container: Element, id: string): boolean =>
  card(container, id).querySelector(".hib-group")?.classList.contains("open") ?? false;
const events = (): unknown[] => vi.mocked(emitEvent).mock.calls.map((call) => call[0]);

function withProject(
  projects: UiProjectRow[],
  id: string,
  change: Partial<UiProjectRow>
): UiProjectRow[] {
  return projects.map((project) => (project.id === id ? { ...project, ...change } : project));
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.mocked(emitEvent).mockClear();
    vi.mocked(sendNotificationEvent).mockClear();
  });
  afterEach(async () => {
    // Unmount while the fake timers are still installed: a busy row's clock
    // stops (a microtask after the unmount, which act() awaits) on the timers
    // it started on, before they are swapped back.
    await act();
    cleanup();
    vi.useRealTimers();
  });

  describe("look", () => {
    it("shows no alarm clock and no “your turn”", () => {
      const { container } = setup({ projects: sampleProjects() });
      expect(container.textContent).not.toMatch(/⏰|your turn/i);
      expect(row(container, "codehydra/hibernation-age").querySelector(".meta")).toBeNull();
    });

    it("uses the moon for hibernate and offers only remove on a hibernated row", () => {
      const { container } = setup({ projects: sampleProjects() });
      const busy = row(container, "codehydra/redesign-sidebar");
      expect(
        [...busy.querySelectorAll("[data-act]")].map((b) => b.getAttribute("data-act"))
      ).toEqual(["hibernate", "remove"]);
      for (const el of container.querySelectorAll(".ws.hibernated")) {
        expect([...el.querySelectorAll(".hover-acts [data-act]")].length).toBe(1);
      }
    });

    it("names each row for assistive tech, and takes folded rows out of reach", () => {
      const { container } = setup({ projects: sampleProjects() });
      const label = (key: string): string | null =>
        row(container, key).querySelector("button.st")!.getAttribute("aria-label");
      expect(label("codehydra/redesign-sidebar")).toMatch(/^redesign-sidebar in codehydra - /);
      expect(label("codehydra/opencode-mcp-timeout")).toBe(
        "opencode-mcp-timeout in codehydra - Creating"
      );
      expect(label("codehydra/atomic-state-writes")).toMatch(/ - Hibernated .* - click to wake$/);
      // The hibernated list is folded at rest; infra is collapsed.
      const fold = (key: string) => row(container, key).closest(".cl")!;
      expect(fold("codehydra/atomic-state-writes").hasAttribute("inert")).toBe(true);
      expect(fold("codehydra/atomic-state-writes").getAttribute("aria-hidden")).toBe("true");
      expect(fold("infra/ci-cache").hasAttribute("inert")).toBe(true);
      expect(fold("codehydra/redesign-sidebar").hasAttribute("inert")).toBe(false);
    });

    it("spins for a busy row (in the busy color) and a loading one (grey)", () => {
      const { container } = setup({ projects: sampleProjects() });
      const busy = row(container, "codehydra/redesign-sidebar").querySelector(".st")!;
      expect(busy.querySelector(".ring.busy")).not.toBeNull();
      const loading = row(container, "codehydra/opencode-mcp-timeout").querySelector(".st")!;
      expect(loading.querySelector(".ring.pending")).not.toBeNull();
      expect(loading.querySelector(".ring.busy")).toBeNull();
    });

    it("shows the age of a hibernated row and “working” on a busy one", () => {
      const { container } = setup({ projects: sampleProjects() });
      expect(
        row(container, "codehydra/find-workspace-dialog").querySelector(".meta")?.textContent
      ).toBe("5h");
      expect(row(container, "acme-api/billing-v2").querySelector(".meta")?.textContent).toBe("2w");
      expect(row(container, "codehydra/redesign-sidebar").querySelector(".meta")?.textContent).toBe(
        "working"
      );
    });

    it("counts a busy row up from when its agent started working", async () => {
      const key = "codehydra/redesign-sidebar";
      const projects = sampleProjects().map((project) => ({
        ...project,
        workspaces: project.workspaces.map((ws) =>
          ws.key === key && ws.agent.type !== "none"
            ? { ...ws, agent: { ...ws.agent, changedAt: new Date(NOW - 42_000).toISOString() } }
            : ws
        ),
      }));
      const { container } = setup({ projects });
      const busyRow = row(container, key);
      const label = (): string | null =>
        busyRow.querySelector("button.st")!.getAttribute("aria-label");
      expect(busyRow.querySelector(".meta")?.textContent).toBe("42s");
      expect(label()).toMatch(/ busy for less than a minute$/);
      const since = new Date(NOW - 42_000).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
      expect(busyRow.querySelector(".ring.busy")?.getAttribute("title")).toBe(
        `Agent working since ${since}`
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(busyRow.querySelector(".meta")?.textContent).toBe("43s");

      await vi.advanceTimersByTimeAsync(65 * 60_000);
      expect(busyRow.querySelector(".meta")?.textContent).toBe("1h 5m");
      expect(label()).toMatch(/ busy for 1 hour 5 minutes$/);
    });

    it("explains an automated row on hover (no icon)", () => {
      const { container } = setup({ projects: sampleProjects() });
      expect(row(container, "codehydra/ci-watch").getAttribute("title")).toBe(
        "Wakes automatically: gh pr checks 812"
      );
    });

    it("sums working, loading, idle, no agent, hibernated and automated in the footer", () => {
      const { container } = setup({ projects: sampleProjects() });
      const sum = [...container.querySelectorAll(".sb-foot .sum i")].map((i) => i.textContent);
      expect(sum).toEqual(["4", "1", "4", "3", "5", "3"]);
      // Loading is the grey spinner, working the red one; no agent the hollow dot.
      expect(container.querySelector(".sb-foot .sum .loading .ring:not(.busy)")).not.toBeNull();
      expect(container.querySelector(".sb-foot .sum .none .dot")).not.toBeNull();
      expect(container.querySelector(".sb-foot .sum")!.getAttribute("title")).toBe(
        "4 working · 1 loading · 4 waiting for you · 3 no agent · 5 hibernated · 3 automated"
      );
    });

    it("leaves a zero count out of the footer and its tooltip", () => {
      const withAgents = sampleProjects().map((project) => ({
        ...project,
        workspaces: project.workspaces.filter(
          (row) =>
            !row.hibernated &&
            row.status === "ready" &&
            (row.agent.type === "busy" || row.agent.type === "idle")
        ),
      }));
      const { container } = setup({ projects: withAgents });
      const sum = container.querySelector(".sb-foot .sum")!;
      expect(sum.querySelectorAll("i").length).toBe(2);
      expect(sum.getAttribute("title")).toBe("4 working · 4 waiting for you");
    });
  });

  describe("hibernated list", () => {
    it("is hidden at rest; the button counts hibernated (moon) and automated (alarm) apart", () => {
      const { container } = setup({ projects: sampleProjects() });
      const counts = (projectId: string) => {
        const button = card(container, projectId).querySelector(".sleepers")!;
        return {
          hibernated: button.querySelector(".hib")?.textContent ?? null,
          automated: button.querySelector(".auto")?.textContent ?? null,
        };
      };
      expect(hibGroupOpen(container, "codehydra")).toBe(false);
      expect(counts("codehydra")).toEqual({ hibernated: "2", automated: "2" });
      expect(counts("acme-api")).toEqual({ hibernated: "1", automated: "1" });
      expect(counts("website")).toEqual({ hibernated: "1", automated: null });
    });

    it("an expanded header counts the other rows beside the button, which alone toggles the list", async () => {
      const { container } = setup({ projects: sampleProjects() });
      const code = card(container, "codehydra");
      expect(code.classList.contains("closed")).toBe(false);
      const cnt = code.querySelector(".cnt")!;
      expect(cnt.getAttribute("title")).toBe("1 working · 1 loading · 1 waiting for you");
      expect([...cnt.querySelectorAll(":scope > i")].map((i) => i.textContent)).toEqual([
        "1",
        "1",
        "1",
      ]);
      expect(code.querySelector(".sleepers .hib")?.textContent).toBe("2");

      await fireEvent.click(cnt);
      expect(events()).toContainEqual({
        kind: "toggle-project-collapsed",
        projectId: "codehydra",
      });
    });

    it("the button counts only ready rows, and is a bare moon while none are", () => {
      const rows = (status: "ready" | "deleting") => [
        makeUiWorkspaceRow("sleeping", { key: "website/sleeping", hibernated: true, status }),
        makeUiWorkspaceRow("cron", {
          key: "website/cron",
          hibernated: true,
          status,
          wakeupScript: "cron",
        }),
      ];
      const { container, rerender } = setup({
        projects: withProject(sampleProjects(), "website", {
          workspaces: [
            ...rows("ready"),
            makeUiWorkspaceRow("gone", {
              key: "website/gone",
              hibernated: true,
              status: "deleting",
            }),
          ],
          hibernatedView: "manual",
        }),
      });
      const site = card(container, "website");
      expect(site.querySelector(".sleepers .hib")?.textContent).toBe("1");
      expect(site.querySelector(".sleepers .auto")?.textContent).toBe("1");
      expect(site.querySelector(".auto-menu")?.textContent).toContain(
        "Show automated workspaces (1)"
      );

      rerender({
        projects: withProject(sampleProjects(), "website", {
          workspaces: rows("deleting"),
          hibernatedView: "manual",
        }),
      });
      const button = site.querySelector(".sleepers")!;
      expect(button.querySelector(":scope > .sb-icon")).not.toBeNull();
      expect(button.querySelector(".auto")).toBeNull();
      expect(button.textContent?.trim()).toBe("");
      expect(site.querySelector(".auto-menu")?.textContent?.trim()).toBe(
        "Show automated workspaces"
      );
    });

    it("the moon asks to show the list, and to hide it again", async () => {
      const projects = sampleProjects();
      const { container, rerender } = setup({ projects });
      await fireEvent.click(card(container, "codehydra").querySelector(".sleepers")!);
      expect(events()).toContainEqual({
        kind: "set-hibernated-view",
        projectId: "codehydra",
        view: "manual",
      });
      rerender({ projects: withProject(projects, "codehydra", { hibernatedView: "manual" }) });
      expect(hibGroupOpen(container, "codehydra")).toBe(true);
      expect(rowOpen(container, "codehydra/ci-watch")).toBe(false);
      vi.mocked(emitEvent).mockClear();
      await fireEvent.click(card(container, "codehydra").querySelector(".sleepers")!);
      expect(events()).toEqual([
        { kind: "set-hibernated-view", projectId: "codehydra", view: "hidden" },
      ]);
    });

    it("offers “Show automated workspaces” in their own color, which shows them", async () => {
      const projects = withProject(sampleProjects(), "codehydra", { hibernatedView: "manual" });
      const { container, rerender } = setup({ projects });
      const menu = card(container, "codehydra").querySelector(".auto-menu")!;
      expect(menu.textContent).toContain("Show automated workspaces (2)");
      expect(menu.closest(".cl")?.classList.contains("open")).toBe(true);
      await fireEvent.click(menu);
      expect(events()).toContainEqual({
        kind: "set-hibernated-view",
        projectId: "codehydra",
        view: "all",
      });
      rerender({ projects: withProject(projects, "codehydra", { hibernatedView: "all" }) });
      expect(menu.closest(".cl")?.classList.contains("open")).toBe(false);
      expect(rowOpen(container, "codehydra/ci-watch")).toBe(true);
      expect(row(container, "codehydra/ci-watch").classList.contains("auto")).toBe(true);
    });

    it("lists hibernated, then automated, then awake rows, each in main's order", () => {
      const { container } = setup({ projects: sampleProjects() });
      const keys = [...card(container, "codehydra").querySelectorAll(".ws")].map(
        (el) => (el as HTMLElement).dataset.key
      );
      expect(keys.slice(0, 4)).toEqual([
        "codehydra/find-workspace-dialog",
        "codehydra/atomic-state-writes",
        "codehydra/ci-watch",
        "codehydra/release-notes",
      ]);
    });

    it("folds away when the pointer leaves the card, or on a click elsewhere in it", async () => {
      const projects = withProject(sampleProjects(), "codehydra", { hibernatedView: "manual" });
      const { container } = setup({ projects });
      await fireEvent.mouseLeave(card(container, "codehydra"));
      expect(events()).toContainEqual({
        kind: "set-hibernated-view",
        projectId: "codehydra",
        view: "hidden",
      });
      vi.mocked(emitEvent).mockClear();
      await fireEvent.click(row(container, "codehydra/hibernation-age"));
      expect(events()[0]).toEqual({
        kind: "set-hibernated-view",
        projectId: "codehydra",
        view: "hidden",
      });
    });

    it("stays open around the active hibernated workspace", () => {
      const { container } = setup({ projects: sampleProjects("codehydra/atomic-state-writes") });
      expect(hibGroupOpen(container, "codehydra")).toBe(true);
    });
  });

  describe("collapsed project", () => {
    it("counts its rows instead of the moon button, naming only what it shows", () => {
      const { container } = setup({ projects: sampleProjects() });
      const infra = card(container, "infra");
      expect(infra.classList.contains("closed")).toBe(true);
      expect(infra.querySelector(".sleepers")).toBeNull();
      // k8s-autoscaling has no agent: it is not counted as idle (the footer agrees).
      expect([...infra.querySelectorAll(".cnt i")].map((i) => i.textContent)).toEqual([
        "1",
        "1",
        "1",
        "1",
      ]);
      expect(infra.querySelector(".cnt")!.getAttribute("title")).toBe(
        "1 working · 1 waiting for you · 1 no agent · 1 hibernated"
      );
    });

    it("counts a row mid-change as loading only, and a failed row nowhere", () => {
      const projects = withProject(sampleProjects(), "infra", {
        workspaces: [
          makeUiWorkspaceRow("sleeping", { key: "infra/sleeping", hibernated: true }),
          makeUiWorkspaceRow("gone", { key: "infra/gone", hibernated: true, status: "deleting" }),
          makeUiWorkspaceRow("stuck", {
            key: "infra/stuck",
            hibernated: true,
            status: "delete-failed",
          }),
          makeUiWorkspaceRow("cron", {
            key: "infra/cron",
            hibernated: true,
            wakeupScript: "cron",
          }),
        ],
      });
      const { container } = setup({ projects });
      const cnt = card(container, "infra").querySelector(".cnt")!;
      expect(cnt.getAttribute("title")).toBe("1 loading · 1 hibernated · 1 automated");
      expect(cnt.querySelector(".loading")?.textContent).toBe("1");
      expect(cnt.querySelector(".auto")?.textContent).toBe("1");
      expect(cnt.querySelectorAll("i").length).toBe(3);
    });

    it("has no counts and no tooltip with nothing to count", () => {
      const projects = withProject(sampleProjects(), "infra", {
        workspaces: [makeUiWorkspaceRow("stuck", { key: "infra/stuck", status: "open-failed" })],
      });
      const { container } = setup({ projects });
      const cnt = card(container, "infra").querySelector(".cnt")!;
      expect(cnt.querySelectorAll("i").length).toBe(0);
      expect(cnt.hasAttribute("title")).toBe(false);
    });

    it("its header toggles it (and not while Find has the focus)", async () => {
      const { container } = setup({ projects: sampleProjects() });
      await fireEvent.click(card(container, "website").querySelector(".proj-h")!);
      expect(events()).toContainEqual({ kind: "toggle-project-collapsed", projectId: "website" });
      vi.mocked(emitEvent).mockClear();
      await fireEvent.focus(container.querySelector("input")!);
      await fireEvent.click(card(container, "website").querySelector(".proj-h")!);
      expect(events()).not.toContainEqual(
        expect.objectContaining({ kind: "toggle-project-collapsed" })
      );
    });
  });

  describe("row gestures", () => {
    it("switches on click; a hibernated row wakes; a failed one opens again", async () => {
      const { container } = setup({ projects: sampleProjects() });
      await fireEvent.click(row(container, "website/blog-rss"));
      expect(events()).toEqual([{ kind: "switch-workspace", key: "website/blog-rss" }]);
      vi.mocked(emitEvent).mockClear();
      await fireEvent.click(row(container, "website/i18n"));
      expect(events()).toEqual([
        { kind: "wake-workspace", key: "website/i18n" },
        { kind: "switch-workspace", key: "website/i18n" },
      ]);
      vi.mocked(emitEvent).mockClear();
      await fireEvent.click(row(container, "codehydra/e2e-flake-hunt"));
      expect(events()).toEqual([
        { kind: "wake-workspace", key: "codehydra/e2e-flake-hunt" },
        { kind: "switch-workspace", key: "codehydra/e2e-flake-hunt" },
      ]);
    });

    it("hover actions hibernate and remove without switching", async () => {
      const { container } = setup({ projects: sampleProjects() });
      const target = row(container, "website/dark-mode");
      await fireEvent.click(target.querySelector('[data-act="hibernate"]')!);
      await fireEvent.click(target.querySelector('[data-act="remove"]')!);
      expect(events()).toEqual([
        { kind: "hibernate-workspace", key: "website/dark-mode" },
        { kind: "remove-workspace", key: "website/dark-mode" },
      ]);
    });

    it("the project's + opens the form for that project; trash closes the project", async () => {
      const { container } = setup({ projects: sampleProjects() });
      await fireEvent.click(card(container, "acme-api").querySelector('[data-act="newin"]')!);
      await fireEvent.click(card(container, "acme-api").querySelector('[data-act="closeproj"]')!);
      expect(events()).toEqual([
        { kind: "open-new-workspace", projectId: "acme-api" },
        { kind: "close-project", projectId: "acme-api" },
      ]);
    });

    it("the footer opens the form, shows processes, docks, opens settings and help", async () => {
      const { container } = setup({ projects: sampleProjects() });
      for (const button of container.querySelectorAll(".sb-foot button")) {
        await fireEvent.click(button);
      }
      expect(events()).toEqual([
        { kind: "open-new-workspace", projectId: null },
        { kind: "set-sidebar-process-summary", mode: "total" },
        { kind: "set-sidebar-mode", mode: "overlay" },
        { kind: "open-settings" },
        { kind: "open-help" },
      ]);
    });
  });

  describe("Find", () => {
    it("/ opens Find, but not while typing in a field — one inside a shadow root too", () => {
      const { container } = setup({ projects: sampleProjects() });
      const find = container.querySelector("input")!;

      // A <vscode-textfield>: its <input> lives in a shadow root.
      const host = document.createElement("div");
      document.body.appendChild(host);
      const field = host
        .attachShadow({ mode: "open" })
        .appendChild(document.createElement("input"));
      field.focus();
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", bubbles: true, composed: true, cancelable: true })
      );
      expect(document.activeElement).not.toBe(find);

      field.blur();
      const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      document.body.dispatchEvent(slash);
      expect(slash.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(find);
      host.remove();
    });

    it("opens every project and shows hibernated (not automated) rows", async () => {
      const { container } = setup({ projects: sampleProjects() });
      const infra = card(container, "infra");
      await fireEvent.focus(container.querySelector("input")!);
      expect(events()).toContainEqual({ kind: "set-find", active: true });
      expect(container.querySelectorAll(".proj.closed").length).toBe(0);
      expect(card(container, "infra")).toBe(infra);
      expect(hibGroupOpen(container, "codehydra")).toBe(true);
      expect(rowOpen(container, "codehydra/ci-watch")).toBe(false);
      expect(rowOpen(container, "codehydra/atomic-state-writes")).toBe(true);
    });

    it("Alt+X, T's views decide which hibernated rows Find shows", async () => {
      const { container, rerender } = setup({ projects: sampleProjects() });
      await fireEvent.focus(container.querySelector("input")!);
      rerender({ find: { hibernatedView: "all" } });
      expect(rowOpen(container, "codehydra/ci-watch")).toBe(true);
      rerender({ find: { hibernatedView: "hidden" } });
      expect(hibGroupOpen(container, "codehydra")).toBe(false);
    });

    it("filters by project, title, branch or tag and marks the match", async () => {
      const { container } = setup({ projects: sampleProjects() });
      const input = container.querySelector("input")!;
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "pkce" } });
      expect(rowOpen(container, "acme-api/oauth-pkce")).toBe(true);
      expect(rowOpen(container, "acme-api/rate-limit")).toBe(false);
      expect(card(container, "website").closest(".cl")?.classList.contains("open")).toBe(false);
      expect(row(container, "acme-api/oauth-pkce").querySelector("mark")?.textContent).toBe("PKCE");
      await fireEvent.input(input, { target: { value: "design" } });
      expect(rowOpen(container, "website/landing-redesign")).toBe(true);
      await fireEvent.input(input, { target: { value: "zzz" } });
      expect(container.querySelector(".empty")?.textContent).toContain("zzz");
    });

    it("matches several words across fields and marks each", async () => {
      const { container } = setup({ projects: sampleProjects() });
      const input = container.querySelector("input")!;
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "acm login pkce" } });
      expect(rowOpen(container, "acme-api/oauth-pkce")).toBe(true);
      expect(rowOpen(container, "acme-api/rate-limit")).toBe(false);
      expect(card(container, "acme-api").querySelector(".name mark")?.textContent).toBe("acm");
      const title = row(container, "acme-api/oauth-pkce").querySelector(".title")!;
      expect([...title.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
        "login",
        "PKCE",
      ]);
      expect(title.textContent).toBe("Switch login to PKCE");
    });

    it("puts the marker on the active row, moves it with the arrows and Enter switches", async () => {
      const { container } = setup({ projects: sampleProjects() });
      const input = container.querySelector("input")!;
      await fireEvent.focus(input);
      expect(row(container, "codehydra/redesign-sidebar").classList.contains("sel")).toBe(true);
      await fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(row(container, "acme-api/billing-v2").classList.contains("sel")).toBe(true);
      await fireEvent.keyDown(input, { key: "Home" });
      expect(row(container, "codehydra/find-workspace-dialog").classList.contains("sel")).toBe(
        true
      );
      vi.mocked(emitEvent).mockClear();
      await fireEvent.keyDown(input, { key: "Enter" });
      expect(events()).toEqual([
        { kind: "set-find", active: false },
        { kind: "wake-workspace", key: "codehydra/find-workspace-dialog" },
        { kind: "switch-workspace", key: "codehydra/find-workspace-dialog" },
      ]);
    });

    it("Escape leaves Find and gives the workspace the focus", async () => {
      const focusFrame = vi.fn();
      (window as Window & { __chFocusActiveFrame?: () => void }).__chFocusActiveFrame = focusFrame;
      const { container } = setup({ projects: sampleProjects() });
      const input = container.querySelector("input")!;
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: "ci" } });
      await fireEvent.keyDown(input, { key: "Escape" });
      expect(input.value).toBe("");
      expect(events()).toContainEqual({ kind: "set-find", active: false });
      expect(focusFrame).toHaveBeenCalled();
      expect(card(container, "infra").classList.contains("closed")).toBe(true);
    });

    it("Alt+X, F (main opening Find) focuses the field", () => {
      const { container, rerender } = setup({ projects: sampleProjects(), find: null });
      rerender({ find: { hibernatedView: "manual" } });
      expect(document.activeElement).toBe(container.querySelector("input"));
    });
  });

  describe("questions", () => {
    const deploy = question("q1", "acme-api/oauth-pkce", "Deploy to staging?", ["Deploy", "Skip"]);

    it("a question is a card in its row, with its answers and a × to cancel", async () => {
      const { container } = setup({ projects: sampleProjects(), notifications: [deploy] });
      const note = row(container, "acme-api/oauth-pkce").querySelector(".note.question")!;
      expect([...note.querySelectorAll(".nacts button")].map((b) => b.textContent?.trim())).toEqual(
        ["Deploy", "Skip"]
      );
      expect(container.querySelector(".notes .note")).toBeNull();
      expect(card(container, "acme-api").querySelector(".hdr-note")).toBeNull();
      await fireEvent.click(note.querySelector(".nacts button")!);
      expect(sendNotificationEvent).toHaveBeenCalledWith({
        notificationId: "q1",
        actionId: "Deploy",
      });
      await fireEvent.click(note.querySelector(".nx")!);
      expect(sendNotificationEvent).toHaveBeenCalledWith({
        notificationId: "q1",
        actionId: "dismiss",
      });
      expect(events()).toEqual([]);
    });

    it("two questions are two cards", () => {
      const second = question("q2", "acme-api/oauth-pkce", "Push?", ["Push"]);
      const { container } = setup({ projects: sampleProjects(), notifications: [deploy, second] });
      expect(row(container, "acme-api/oauth-pkce").querySelectorAll(".note.question").length).toBe(
        2
      );
    });

    it("a question arriving for a collapsed project expands it", () => {
      const { container, rerender } = setup({ projects: sampleProjects() });
      rerender({ notifications: [question("q3", "infra/ci-cache", "Migrate?", ["Run now"])] });
      expect(events()).toEqual([{ kind: "toggle-project-collapsed", projectId: "infra" }]);
      expect(container.querySelector(".hdr-note")).toBeNull();
    });

    it("a question arriving for a hibernated row opens its list", () => {
      const { rerender } = setup({ projects: sampleProjects() });
      rerender({ notifications: [question("q4", "codehydra/ci-watch", "Retry?", ["Yes"])] });
      expect(events()).toEqual([
        { kind: "set-hibernated-view", projectId: "codehydra", view: "all" },
      ]);
    });

    it("a question arriving for a row in sight changes nothing", () => {
      const { rerender } = setup({ projects: sampleProjects() });
      rerender({ notifications: [deploy] });
      expect(events()).toEqual([]);
    });
  });

  describe("notifications at the bottom", () => {
    const error: UiNotification = {
      id: "e1",
      count: 3,
      config: {
        type: "error",
        title: "Wakeup script failed",
        message: "gh: authentication required",
        dismissible: true,
        actions: [{ id: "openlog", label: "Open log" }],
      },
      workspace: { key: "codehydra/ci-watch", name: "Fix CI once #812 is green" },
    };
    const info: UiNotification = { id: "i1", config: { type: "info", title: "Nightly build" } };

    it("shows newest on top, with counter, workspace link and buttons", async () => {
      const { container } = setup({ projects: sampleProjects(), notifications: [error, info] });
      const notes = [...container.querySelectorAll(".notes .note")];
      expect(notes.map((n) => n.getAttribute("data-note-id"))).toEqual(["i1", "e1"]);
      expect(notes[1]?.textContent).toContain("×3");
      expect(card(container, "codehydra").querySelector(".hdr-note")).toBeNull();
      await fireEvent.click(notes[1]!.querySelector(".nws")!);
      expect(events()).toEqual([{ kind: "switch-workspace", key: "codehydra/ci-watch" }]);
      await fireEvent.click(notes[1]!.querySelector(".nacts button")!);
      expect(sendNotificationEvent).toHaveBeenCalledWith({
        notificationId: "e1",
        actionId: "openlog",
      });
    });
  });

  describe("shortcut mode", () => {
    it("numbers the awake rows of expanded projects", () => {
      const { container } = setup({ projects: sampleProjects(), shortcutModeActive: true });
      const numbered = [...container.querySelectorAll(".ws")].filter((el) =>
        el.querySelector(".meta kbd")
      );
      expect(numbered.length).toBe(10);
      expect(
        row(container, "codehydra/e2e-flake-hunt").querySelector(".meta kbd")?.textContent
      ).toBe("1");
      expect(container.querySelector('.ws[data-key="infra/ci-cache"] .meta kbd')).toBeNull();
    });
  });

  describe("hover expansion", () => {
    const nav = (container: Element): Element => container.querySelector("nav.sidebar")!;
    const hovers = (): unknown[] =>
      events().filter((event) => (event as { kind: string }).kind === "hover");

    it("expands after the hover delay", async () => {
      const { container } = setup({
        projects: sampleProjects(),
        sidebarMode: "overlay",
        mode: "workspace",
      });
      await fireEvent.mouseEnter(nav(container));
      expect(hovers()).toEqual([]);
      vi.advanceTimersByTime(150);
      expect(hovers()).toEqual([{ kind: "hover", region: "sidebar" }]);
    });

    it("an enter before main echoed the collapse takes the hover back", async () => {
      const { container, rerender } = setup({
        projects: sampleProjects(),
        sidebarMode: "overlay",
        mode: "workspace",
      });
      await fireEvent.mouseEnter(nav(container));
      vi.advanceTimersByTime(150);
      rerender({ mode: "hover" });

      await fireEvent.mouseLeave(nav(container));
      vi.advanceTimersByTime(150);
      expect(hovers().at(-1)).toEqual({ kind: "hover", region: null });

      // Main has not pushed mode "workspace" yet: the sidebar still shows expanded.
      vi.mocked(emitEvent).mockClear();
      await fireEvent.mouseEnter(nav(container));
      expect(hovers()).toEqual([{ kind: "hover", region: "sidebar" }]);
    });
  });

  describe("process summary", () => {
    const MIB = 1024 * 1024;
    /** The sample projects as main sends them with the summary on: totals on the awake rows. */
    function withProcesses(): UiProjectRow[] {
      return sampleProjects().map((project) => ({
        ...project,
        workspaces: project.workspaces.map((ws) =>
          ws.hibernated
            ? ws
            : { ...ws, processes: { cpuPercent: 10, rssBytes: 100 * MIB, count: 2 } }
        ),
      }));
    }
    const meta = (container: Element, key: string): string =>
      row(container, key).querySelector(".meta")?.textContent?.trim() ?? "";
    const rowStats = (container: Element, key: string): string | null =>
      row(container, key).querySelector(".sub .proc")?.textContent ?? null;

    /** A project with only hibernated rows, so with no process total. */
    function asleep(): UiProjectRow {
      const first = withProcesses()[0]!;
      return {
        ...first,
        id: "asleep",
        workspaces: first.workspaces.filter((ws) => ws.hibernated),
      };
    }

    it("toggles from the footer button, which shows whether it is on", async () => {
      // Scoped to this render: the page can still hold an earlier test's sidebar.
      const { container, rerender } = setup({ projects: sampleProjects() });
      const footerButton = (label: string): Element => {
        const el = container.querySelector(`.sb-foot button[aria-label="${label}"]`);
        if (el === null) throw new Error(`no footer button "${label}"`);
        return el;
      };
      const button = footerButton("Show process summary");
      expect(button.getAttribute("aria-pressed")).toBe("false");
      await fireEvent.click(button);
      expect(events()).toContainEqual({ kind: "set-sidebar-process-summary", mode: "total" });

      rerender({ processSummary: "total", projects: withProcesses() });
      const on = footerButton("Hide process summary");
      expect(on.getAttribute("aria-pressed")).toBe("true");
      expect(on.classList.contains("on")).toBe(true);
    });

    it("puts each awake row's CPU and memory on its second line; the row's end keeps “working” and the age", () => {
      const { container, rerender } = setup({ projects: sampleProjects() });
      expect(meta(container, "codehydra/redesign-sidebar")).toBe("working");
      expect(rowStats(container, "codehydra/redesign-sidebar")).toBeNull();

      rerender({ processSummary: "total", projects: withProcesses() });
      expect(meta(container, "codehydra/redesign-sidebar")).toBe("working");
      expect(rowStats(container, "codehydra/redesign-sidebar")).toBe("10% · 100M · 2");
      expect(rowStats(container, "codehydra/hibernation-age")).toBe("10% · 100M · 2");
      expect(meta(container, "codehydra/find-workspace-dialog")).toBe("5h");
      expect(rowStats(container, "codehydra/find-workspace-dialog")).toBeNull();
      expect(row(container, "codehydra/hibernation-age").getAttribute("title")).toBe(
        "10% CPU · 100M memory · 2 processes"
      );
    });

    it("keeps the row's meta on the first line, so every summary ends at the row's right edge", () => {
      // jsdom has no layout: the structure is what makes the summaries line up.
      // A meta beside the two lines took its width off a busy row's second line.
      const { container } = setup({ processSummary: "total", projects: withProcesses() });
      const busy = row(container, "codehydra/redesign-sidebar");
      expect(busy.querySelector(".txt > .head > .meta")?.textContent).toBe("working");
      expect(busy.querySelector(".txt > .sub > .proc")).not.toBeNull();
      expect(busy.querySelector(":scope > .meta, :scope > .enter")).toBeNull();
      expect(row(container, "codehydra/hibernation-age").querySelector(".meta")).toBeNull();
    });

    it("gives an awake row without title or tags a second line only for the summary", () => {
      const first = sampleProjects()[0]!;
      const plain: UiProjectRow = {
        ...first,
        workspaces: first.workspaces.map((ws) => {
          const untitled = { ...ws, tags: [] };
          delete untitled.title;
          return untitled;
        }),
      };
      const key = plain.workspaces.find((ws) => !ws.hibernated && ws.status === "ready")!.key;
      const { container, rerender } = setup({ projects: [plain] });
      expect(row(container, key).querySelector(".sub")).toBeNull();

      const on: UiProjectRow = {
        ...plain,
        workspaces: plain.workspaces.map((ws) =>
          ws.hibernated
            ? ws
            : { ...ws, processes: { cpuPercent: 10, rssBytes: 100 * MIB, count: 2 } }
        ),
      };
      rerender({ processSummary: "total", projects: [on] });
      expect(rowStats(container, key)).toBe("10% · 100M · 2");
    });

    it("gives every project with a total a pulse icon, its numbers on hover, collapsed or expanded", () => {
      const { container, rerender } = setup({ projects: sampleProjects() });
      expect(container.querySelector(".proc-icon")).toBeNull();

      rerender({ processSummary: "total", projects: [...withProcesses(), asleep()] });
      // infra is collapsed and has three awake rows; website is expanded.
      expect(card(container, "infra").querySelector(".proc-icon")?.getAttribute("title")).toBe(
        "infra: 30% CPU · 300M memory · 6 processes"
      );
      expect(card(container, "website").querySelector(".proc-icon")?.getAttribute("title")).toBe(
        "website: 30% CPU · 300M memory · 6 processes"
      );
      expect(card(container, "asleep").querySelector(".proc-icon")).toBeNull();
      // The numbers themselves are never in the header.
      expect(card(container, "infra").querySelector(".proj-h")?.textContent).not.toContain("300M");
    });

    describe("process bar", () => {
      const totals: UiProcessTotals = {
        all: { cpuPercent: 150, rssBytes: 2048 * MIB, count: 40 },
        workspaces: { cpuPercent: 130, rssBytes: 1536 * MIB, count: 26 },
        codeServer: { cpuPercent: 15, rssBytes: 384 * MIB, count: 10 },
        codehydra: { cpuPercent: 5, rssBytes: 128 * MIB, count: 4 },
      };
      const split = [
        "All of CodeHydra: 150% CPU · 2.0G memory · 40 processes",
        "Workspaces: 130% CPU · 1.5G memory · 26 processes",
        "Code server: 15% CPU · 384M memory · 10 processes",
        "CodeHydra itself: 5% CPU · 128M memory · 4 processes",
      ].join("\n");
      const pulse = (container: Element): Element =>
        container.querySelector('.sb-foot button[aria-label$="process summary"]')!;
      const bar = (container: Element): Element => container.querySelector(".procf")!;
      const badge = (container: Element): Element => bar(container).querySelector(".proc")!;
      /** Each number as `<part>:<text>`, checking it starts with its icon. */
      const parts = (container: Element): string[] =>
        [...badge(container).querySelectorAll(".pm")].map((part) => {
          expect(part.firstElementChild?.tagName.toLowerCase()).toBe("svg");
          return `${part.getAttribute("data-part")}:${part.textContent}`;
        });

      it("folds open above the footer with all of CodeHydra, split in its tooltip", () => {
        const { container, rerender } = setup({
          projects: sampleProjects(),
          processTotals: totals,
        });
        // Off: folded away and out of reach, even with totals still around.
        expect(bar(container).classList.contains("open")).toBe(false);
        expect(bar(container).hasAttribute("inert")).toBe(true);
        expect(bar(container).nextElementSibling?.classList.contains("sb-foot")).toBe(true);

        rerender({ processSummary: "total", projects: withProcesses() });
        expect(bar(container).classList.contains("open")).toBe(true);
        expect(bar(container).hasAttribute("inert")).toBe(false);
        expect(parts(container)).toEqual(["cpu:150%", "memory:2.0G", "count:40"]);
        expect(badge(container).getAttribute("title")).toBe(split);
        expect(badge(container).getAttribute("aria-label")).toBe(split);
      });

      it("shows placeholders before the first scan", () => {
        const { container } = setup({ projects: withProcesses(), processSummary: "total" });
        expect(bar(container).classList.contains("open")).toBe(true);
        expect(parts(container)).toEqual(["cpu:–%", "memory:–", "count:–"]);
        expect(badge(container).getAttribute("title")).toBe("All of CodeHydra: not measured yet");
      });

      it("leaves the footer row without numbers and the pulse button's tooltip the hint", () => {
        const { container } = setup({
          projects: withProcesses(),
          processSummary: "total",
          processTotals: totals,
        });
        expect(container.querySelector(".sb-foot .proc")).toBeNull();
        expect(pulse(container).getAttribute("title")).toBe("Hide process summary (Alt+X, P)");
        expect(pulse(container).hasAttribute("aria-describedby")).toBe(false);
      });

      it("turns the summary off, and back on at the last level, from the pulse button", () => {
        const { container, rerender } = setup({
          projects: withProcesses(),
          processSummary: "breakdown",
          processLevel: "breakdown",
        });
        vi.mocked(emitEvent).mockClear();
        fireEvent.click(pulse(container));
        expect(events()).toEqual([{ kind: "set-sidebar-process-summary", mode: "off" }]);

        rerender({ processSummary: "off", processLevel: "tree" });
        vi.mocked(emitEvent).mockClear();
        fireEvent.click(pulse(container));
        expect(events()).toEqual([{ kind: "set-sidebar-process-summary", mode: "tree" }]);
      });

      const levelButton = (container: Element, label: string): HTMLElement =>
        bar(container).querySelector<HTMLElement>(`.levels button[aria-label="${label}"]`)!;

      it("picks the level with its buttons, the current one pressed", () => {
        const { container } = setup({
          projects: withProcesses(),
          processSummary: "total",
          processLevel: "total",
          processTotals: totals,
        });
        expect(levelButton(container, "Total").getAttribute("aria-pressed")).toBe("true");
        expect(levelButton(container, "Total").classList.contains("on")).toBe(true);
        expect(levelButton(container, "Process tree").getAttribute("aria-pressed")).toBe("false");

        vi.mocked(emitEvent).mockClear();
        fireEvent.click(levelButton(container, "Breakdown"));
        expect(events()).toEqual([{ kind: "set-sidebar-process-summary", mode: "breakdown" }]);
      });

      it("breaks the total down into workspaces, code server and CodeHydra", () => {
        const { container } = setup({
          projects: withProcesses(),
          processSummary: "breakdown",
          processLevel: "breakdown",
          processTotals: totals,
        });
        const rows = [...bar(container).querySelectorAll(".parts .row")].map((row) =>
          [
            row.querySelector(".lbl")?.textContent,
            ...[...row.querySelectorAll(".v")].map((v) => v.textContent),
          ].join(" ")
        );
        expect(rows).toEqual([
          "Workspaces 130% 1.5G 26",
          "Code server 15% 384M 10",
          "CodeHydra 5% 128M 4",
        ]);
      });

      describe("tree", () => {
        const node = (
          pid: number,
          name: string,
          children: UiProcessNode[] = [],
          rssBytes = MIB
        ): UiProcessNode => ({
          pid,
          startedAt: `2026-01-01T00:00:0${pid % 10}.000Z`,
          name,
          commandLine: `${name} --serve`,
          cwd: "/ws/a",
          ports: pid === 12 ? [5173] : [],
          subtree: { cpuPercent: 1, rssBytes, count: 1 + children.length },
          children,
        });
        const vite = node(12, "vite");
        const pnpm = node(11, "pnpm", [vite]);
        const tree: UiProcessTree = {
          projects: [
            {
              id: "p1",
              name: "website",
              total: pnpm.subtree,
              workspaces: [
                { key: "ws-a", name: "feature-a", total: pnpm.subtree, processes: [pnpm] },
              ],
            },
          ],
          codeServer: [node(30, "node")],
          codehydra: [node(40, "codehydra")],
        };
        const labels = (container: Element): string[] =>
          [...bar(container).querySelectorAll(".tree .row .lbl")].map(
            (lbl) => lbl.textContent ?? ""
          );
        const rowOf = (container: Element, label: string): HTMLElement =>
          [...bar(container).querySelectorAll<HTMLElement>(".tree .row")].find((row) =>
            row.querySelector(".lbl")?.textContent?.startsWith(label)
          )!;

        function setupTree() {
          return setup({
            projects: withProcesses(),
            processSummary: "tree",
            processLevel: "tree",
            processTotals: totals,
            processTree: tree,
          });
        }

        it("lists every process under its group, project and workspace, all expanded", () => {
          const { container } = setupTree();
          expect(labels(container)).toEqual([
            "Workspaces",
            "website",
            "feature-a",
            "pnpm11",
            "vite12",
            "Code server",
            "node30",
            "CodeHydra",
            "codehydra40",
          ]);
          expect(rowOf(container, "vite").getAttribute("title")).toContain("ports 5173");
        });

        it("folds a row on click", () => {
          const { container } = setupTree();
          fireEvent.click(rowOf(container, "pnpm"));
          expect(labels(container)).not.toContain("vite12");
          fireEvent.click(rowOf(container, "Workspaces"));
          expect(labels(container)).not.toContain("website");
          fireEvent.click(rowOf(container, "Workspaces"));
          expect(labels(container)).toContain("pnpm11");
        });

        it("kills a workspace's process on the second click only", () => {
          const { container } = setupTree();
          const kill = (): HTMLElement =>
            rowOf(container, "pnpm").querySelector<HTMLElement>(".kill")!;
          vi.mocked(emitEvent).mockClear();

          fireEvent.click(kill());
          expect(kill().textContent).toBe("Kill?");
          expect(events()).toEqual([]);
          // Clicking the button does not fold the row.
          expect(labels(container)).toContain("vite12");

          fireEvent.click(kill());
          expect(events()).toEqual([{ kind: "kill-process", pid: 11, startedAt: pnpm.startedAt }]);
        });

        it("forgets the question when the pointer leaves the row", () => {
          const { container } = setupTree();
          const row = rowOf(container, "pnpm");
          fireEvent.click(row.querySelector(".kill")!);
          fireEvent.mouseLeave(row);
          expect(row.querySelector(".kill")?.textContent).not.toBe("Kill?");
        });

        it("offers no kill for the code server's or CodeHydra's processes", () => {
          const { container } = setupTree();
          expect(rowOf(container, "node").querySelector(".kill")).toBeNull();
          expect(rowOf(container, "codehydra").querySelector(".kill")).toBeNull();
        });

        it("resets its height on a double-click of its top edge", () => {
          const { container } = setup({
            projects: withProcesses(),
            processSummary: "tree",
            processLevel: "tree",
            processTreeHeight: 0.5,
            processTree: tree,
          });
          vi.mocked(emitEvent).mockClear();
          fireEvent.dblClick(bar(container).querySelector(".grip")!);
          expect(events()).toEqual([{ kind: "resize-process-tree", fraction: 0.25 }]);
        });

        it("says so before the first scan", () => {
          const { container } = setup({
            projects: withProcesses(),
            processSummary: "tree",
            processLevel: "tree",
          });
          expect(bar(container).querySelector(".tree .pending")?.textContent).toBe(
            "Not measured yet"
          );
        });
      });
    });
  });

  describe("collapsed rail", () => {
    it("overlay and not hovered: the rail shows awake rows of expanded projects", () => {
      const { container } = setup({
        projects: sampleProjects(),
        sidebarMode: "overlay",
        mode: "workspace",
      });
      expect(container.querySelector(".sb")?.classList.contains("collapsed")).toBe(true);
      const groups = [...container.querySelectorAll(".rail .rgrp")];
      expect(groups.length).toBe(4);
      expect(groups[3]?.querySelectorAll(".r-ws").length).toBe(1);
    });
  });
});
