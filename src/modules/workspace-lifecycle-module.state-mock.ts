/**
 * Behavioral state mock for `WorkspaceClosingQuery`.
 *
 * Real semantics, no dispatcher: claim/release drive the same map the real
 * module keeps, so a test can put a workspace into a teardown and assert what
 * its consumers do — rather than stubbing the answer per call.
 */

import type { WorkspaceClosing } from "../intents/contract";
import type { WorkspaceClosingQuery } from "./workspace-lifecycle-module";
import { Path } from "../utils/path/path";

export interface WorkspaceClosingMock extends WorkspaceClosingQuery {
  /** Put a workspace into a teardown, as the lifecycle module's shutdown hook would. */
  claim(workspacePath: string, reason: WorkspaceClosing): void;
  /** Release it, as a terminal domain event would. */
  release(workspacePath: string): void;
}

/** Create a `WorkspaceClosingQuery` double. Nothing is closing until claimed. */
export function createWorkspaceClosingMock(): WorkspaceClosingMock {
  const closing = new Map<string, WorkspaceClosing>();
  const key = (workspacePath: string): string => new Path(workspacePath).toString();

  return {
    get: (workspacePath: string): WorkspaceClosing | null =>
      closing.get(key(workspacePath)) ?? null,
    claim: (workspacePath: string, reason: WorkspaceClosing): void => {
      closing.set(key(workspacePath), reason);
    },
    release: (workspacePath: string): void => {
      closing.delete(key(workspacePath));
    },
  };
}
