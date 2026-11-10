/**
 * The sidebar prototype's sample data as UiState rows, in the order main
 * sends them (hibernated by time, then automated, then awake by name).
 * Shared by the sidebar tests.
 */

import type { UiNotification, UiProjectRow, UiWorkspaceRow } from "@shared/ui-state";
import { makeUiProjectRow, makeUiWorkspaceRow } from "../test-utils";

export const NOW = new Date(2026, 10, 1, 12, 0).getTime();
const MIN = 60_000;

const idle = { type: "idle", counts: { idle: 1, busy: 0, total: 1 } } as const;
const busy = { type: "busy", counts: { idle: 0, busy: 1, total: 1 } } as const;

function ws(
  project: string,
  name: string,
  overrides: Partial<UiWorkspaceRow> & { ago?: number } = {}
): UiWorkspaceRow {
  const { ago, ...rest } = overrides;
  return makeUiWorkspaceRow(name, {
    key: `${project}/${name}`,
    // Described the way git describes a workspace: its branch, with the branch icon.
    subtitle: name,
    subtitleIcon: "branch",
    ...(ago !== undefined && {
      hibernated: true,
      hibernatedAt: new Date(NOW - ago * MIN).toISOString(),
    }),
    ...rest,
  });
}

export function sampleProjects(activeKey = "codehydra/redesign-sidebar"): UiProjectRow[] {
  const mark = (rows: UiWorkspaceRow[]): UiWorkspaceRow[] =>
    rows.map((row) => (row.key === activeKey ? { ...row, active: true } : row));
  return [
    makeUiProjectRow(
      mark([
        ws("codehydra", "find-workspace-dialog", { ago: 300 }),
        ws("codehydra", "atomic-state-writes", { ago: 4320 }),
        ws("codehydra", "ci-watch", {
          ago: 40,
          title: "Fix CI once #812 is green",
          wakeupScript: "gh pr checks 812",
        }),
        ws("codehydra", "release-notes", {
          ago: 2880,
          wakeupScript: "wake on the next release tag",
        }),
        ws("codehydra", "e2e-flake-hunt", { status: "open-failed", openError: "boom" }),
        ws("codehydra", "hibernation-age", {
          title: "Show hibernation age",
          agent: idle,
          tags: [{ name: "review", color: "#22c55e" }],
        }),
        ws("codehydra", "opencode-mcp-timeout", { status: "creating" }),
        ws("codehydra", "redesign-sidebar", {
          title: "Redesign the sidebar",
          agent: busy,
          tags: [{ name: "design", color: "#a78bfa" }],
        }),
      ]),
      { id: "codehydra", name: "codehydra" }
    ),
    makeUiProjectRow(
      mark([
        ws("acme-api", "billing-v2", { ago: 20160 }),
        ws("acme-api", "cleanup-cron", { ago: 8640, wakeupScript: "wake every Monday 09:00" }),
        ws("acme-api", "oauth-pkce", {
          title: "Switch login to PKCE",
          agent: idle,
          tags: [{ name: "security", color: "#ef4444" }],
        }),
        ws("acme-api", "pg-17-upgrade"),
        ws("acme-api", "rate-limit", { title: "Rate-limit the public endpoints", agent: busy }),
      ]),
      { id: "acme-api", name: "acme-api", remote: true }
    ),
    makeUiProjectRow(
      mark([
        ws("website", "i18n", { ago: 5760 }),
        ws("website", "blog-rss"),
        ws("website", "dark-mode", { title: "Add a dark mode toggle", agent: busy }),
        ws("website", "landing-redesign", {
          agent: idle,
          tags: [{ name: "design", color: "#a78bfa" }],
        }),
      ]),
      { id: "website", name: "website" }
    ),
    makeUiProjectRow(
      mark([
        ws("infra", "old-runner", { ago: 30240 }),
        ws("infra", "ci-cache", {
          title: "Speed up the CI cache",
          agent: idle,
          tags: [{ name: "ci", color: "#38bdf8" }],
        }),
        ws("infra", "k8s-autoscaling"),
        ws("infra", "terraform-upgrade", { agent: busy }),
      ]),
      { id: "infra", name: "infra", remote: true, collapsed: true }
    ),
  ];
}

export function question(
  id: string,
  key: string,
  title: string,
  options: readonly string[]
): UiNotification {
  return {
    id,
    config: {
      type: "question",
      title,
      dismissible: true,
      actions: options.map((label) => ({ id: label, label })),
    },
    workspace: { key, name: key.split("/")[1] ?? key },
  };
}
