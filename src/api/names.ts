/**
 * The operation vocabulary.
 *
 * Declared once, here, as the domain's list of operation names. Entries are
 * checked against it, and every adapter's mapping is a `Record` keyed by it — so
 * an adapter that forgets an operation fails to compile rather than silently
 * omitting it. That exhaustiveness is what stops the surfaces drifting apart;
 * an operation an adapter should NOT expose is written as an explicit `null`.
 */

export const OPERATION_NAMES = [
  "workspace.status",
  "workspace.hibernate",
  "workspace.wake",
  "workspace.create",
  "workspace.delete",
  "workspace.switch",
  "workspace.title",
  "workspace.tag.list",
  "workspace.tag.set",
  "workspace.tag.remove",
  "metadata.get",
  "metadata.set",
  "agent.session",
  "agent.restart",
  "agent.open",
  "agent.close",
  "agent.status.set",
  "agent.lifecycle",
  "vscode.command",
  "vscode.message",
  "vscode.notify",
  "vscode.status-bar",
  "vscode.ask",
  "vscode.browser",
  "vscode.diff",
  "vscode.goto",
  "vscode.preview",
  "system.open",
  "project.list",
  "project.open",
  "project.close",
  "log",
  "report.issue",
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];
