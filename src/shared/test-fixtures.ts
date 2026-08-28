/**
 * Shared test fixtures for creating mock domain objects.
 * Used by both main process and renderer test utilities.
 *
 * Uses v2 API types (Project with id, Workspace with projectId).
 */

import type { Project, Workspace, ProjectId, WorkspaceName } from "./api/types";
import { workspacePathSchema, projectPathSchema } from "../intents/contract";
import { Path } from "../utils/path/path";
import { tmpdir } from "node:os";
import type { ProjectPath, WorkspacePath } from "../intents/contract";

/**
 * Default project ID used in test fixtures.
 */
const DEFAULT_PROJECT_ID = "test-project-12345678" as ProjectId;

// =============================================================================
// Workspace Mock Factory
// =============================================================================

/**
 * Partial workspace override that accepts plain strings for convenience in tests.
 * branch can be explicitly set to null (detached HEAD state).
 */
export type WorkspaceOverrides = Partial<
  Omit<Workspace, "name" | "projectId" | "branch" | "metadata">
> & {
  name?: string;
  projectId?: ProjectId;
  branch?: string | null;
  metadata?: Record<string, string>;
};

/**
 * Creates a mock Workspace with sensible defaults.
 * Uses v2 API types (includes projectId).
 *
 * Default workspace simulates a git worktree at /test/project/.worktrees/feature-1
 *
 * @param overrides - Optional properties to override defaults (accepts plain strings for name)
 */
export function createMockWorkspace(overrides: WorkspaceOverrides = {}): Workspace {
  const name = overrides.name ?? "feature-1";
  // Use "in" check to allow explicit null for branch (detached HEAD)
  const branch = "branch" in overrides ? overrides.branch : name;

  return {
    projectId: overrides.projectId ?? DEFAULT_PROJECT_ID,
    name: name as WorkspaceName,
    branch,
    metadata: { base: branch ?? "main", ...overrides.metadata },
    path: wsPath(overrides.path ?? `/test/project/.worktrees/${name}`),
    ...(overrides.url !== undefined ? { url: overrides.url } : {}),
  };
}

// =============================================================================
// Branded path helpers (tests)
// =============================================================================

/**
 * ## Fixture paths
 *
 * Absolute paths for test fixtures, rooted in the real OS temp directory and
 * built with `Path`.
 *
 * Integration tests used to hardcode POSIX literals (`"/workspace/feature-a"`).
 * `Path` accepts those on Windows — a leading slash is absolute there too — so
 * the suite stayed green on the windows runner while never once feeding the code
 * under test the shape Windows actually produces. That blind spot shipped an
 * unparseable `codehydra-mcp.json`, whose `command` was a native path pasted
 * into already-serialized JSON.
 *
 * The fix is not to invent a Windows-looking path: a literal `C:\workspace\…`
 * guesses a drive letter that may not be the one the tests are running on, and
 * names a directory that exists nowhere, so the moment a fixture reaches real
 * I/O it breaks. Instead every fixture hangs off `os.tmpdir()` — a real
 * directory on a real volume — and is assembled by `Path`, the same class
 * production uses. Whatever the platform's paths look like, the fixtures look
 * like that too, for free.
 *
 * Call sites pick the form they mean, using `Path`'s own API:
 *
 * - `.toNative()` — what the OS hands us and what production passes to a
 *   subprocess or writes into an agent's config. Use it for **inputs** and for
 *   expectations about values deliberately kept native.
 * - `.toString()` — `Path`'s canonical form (POSIX separators, lowercased on
 *   Windows). Use it for **expectations** about anything normalized on the way
 *   in, which is nearly everything CodeHydra stores or compares.
 *
 * The directories are not created. Everything using this runs against the
 * in-memory filesystem mock; the point is that the paths are valid for this
 * machine, not that they exist. A test that really does touch the disk wants
 * `createTempDir()` from `src/utils/testing/test-utils.ts` instead — it creates
 * the directory, resolves Windows 8.3 short paths, and cleans up after itself.
 */
/**
 * Root every fixture path hangs off.
 *
 * A sibling of the `codehydra-test-*` directories `createTempDir()` makes, and
 * deliberately not one of them: nothing here is created, so there is nothing to
 * clean up and no reason to serialize workers behind a shared directory.
 *
 * Exported so `src/test/setup.ts` can fail the run if anything ever appears
 * under it — that would mean a test escaped its filesystem mock.
 */
export const FIXTURE_ROOT = new Path(tmpdir(), "codehydra-fixtures");

/**
 * A fixture path under the shared test root.
 *
 * `testPath("/ws/alpha")` → `/tmp/codehydra-fixtures/ws/alpha` on Linux,
 * `…\AppData\Local\Temp\codehydra-fixtures\ws\alpha` on Windows.
 *
 * **Idempotent**: a path already under the root is returned as it is. That is
 * what lets the fixture factories and state mocks call this on everything that
 * reaches them — a test can write the plain `"/app/config.json"` it means and
 * get the same value as a caller that spelled out `testPath("/app/config.json")`,
 * and neither can end up double-rooted.
 */
export function testPath(...segments: string[]): Path {
  const [first, ...rest] = segments;
  return isFixturePath(first) ? new Path(first, ...rest) : new Path(FIXTURE_ROOT, ...segments);
}

/** Whether `p` already names a location under {@link FIXTURE_ROOT}. */
function isFixturePath(p: string | undefined): p is string {
  if (p === undefined) return false;
  try {
    const normalized = new Path(p).toString();
    const root = FIXTURE_ROOT.toString();
    return normalized === root || normalized.startsWith(`${root}/`);
  } catch {
    return false;
  }
}

/**
 * Mint a branded project/workspace path for a fixture.
 *
 * Tests are producers of contract data like any other caller, so they mint brands the same
 * way production edges do — by normalizing through `Path` and then parsing — rather than
 * with an `as` cast. The normalization is not incidental: every production edge that mints
 * one of these brands does it (`new Path(p).toString()`), so a fixture that skipped it would
 * hand the code under test a shape it never sees at runtime — a native `C:\ws\alpha` rather
 * than the canonical `c:/ws/alpha` everything downstream splits and compares.
 */
/**
 * Normalize a fixture path and root it under {@link FIXTURE_ROOT}.
 *
 * Rooting happens *here* rather than at the call site so a fixture cannot be
 * minted without it. `wsPath("/ws/alpha")` used to be silently accepted as a
 * path at the filesystem root — plausible-looking, belonging to no volume, and
 * fine on Linux right up until something tried to use it. Now it means the same
 * thing as every other fixture: a real location under the temp directory.
 *
 * Idempotent, so a path that already came from a fixture — `ws.path.toString()`,
 * an interpolated child — passes through untouched and stays comparable to the
 * one it was derived from.
 */
function fixturePath(p: string): string {
  try {
    return testPath(p).toString();
  } catch {
    // Some tests mint a deliberately invalid path (empty, relative) to exercise
    // a rejection path. There is nothing to normalize, so hand it through.
    return p;
  }
}

export function projPath(p: string): ProjectPath {
  return projectPathSchema.parse(fixturePath(p));
}

export function wsPath(p: string): WorkspacePath {
  return workspacePathSchema.parse(fixturePath(p));
}

// =============================================================================
// Project Mock Factory
// =============================================================================

/**
 * Options for creating a mock project.
 */
export interface MockProjectOptions {
  /**
   * If true, include a default workspace in the project.
   * Defaults to false for backward compatibility with main process tests.
   */
  includeDefaultWorkspace?: boolean;
}

/**
 * Partial project override that accepts looser types for convenience in tests.
 */
export type ProjectOverrides = Partial<Omit<Project, "workspaces">> & {
  workspaces?: WorkspaceOverrides[] | readonly Workspace[];
};

/**
 * Creates a mock Project with sensible defaults.
 * Uses v2 API types (Project with id).
 *
 * Default project simulates a git repository at /test/project with one workspace.
 * Set `options.includeDefaultWorkspace = false` (or pass `workspaces: []`) to exclude workspaces.
 *
 * @param overrides - Optional properties to override defaults
 * @param options - Options for project creation
 */
export function createMockProject(
  overrides: ProjectOverrides = {},
  options: MockProjectOptions = {}
): Project {
  const projectId = overrides.id ?? DEFAULT_PROJECT_ID;
  // Default to including a workspace (matches renderer test expectations)
  const { includeDefaultWorkspace = true } = options;

  // Convert workspace overrides to Workspace objects
  let workspaces: readonly Workspace[];
  if (overrides.workspaces) {
    workspaces = overrides.workspaces.map((w) => {
      // Check if it's already a Workspace (has projectId as branded type)
      if ("projectId" in w && typeof w.projectId === "string" && w.projectId.includes("-")) {
        return w as Workspace;
      }
      // Otherwise treat as WorkspaceOverrides
      return createMockWorkspace({ ...w, projectId });
    });
  } else if (includeDefaultWorkspace) {
    workspaces = [createMockWorkspace({ projectId })];
  } else {
    workspaces = [];
  }

  return {
    id: projectId,
    name: overrides.name ?? "test-project",
    path: projPath(overrides.path ?? "/test/project"),
    workspaces,
    ...(overrides.defaultBaseBranch !== undefined
      ? { defaultBaseBranch: overrides.defaultBaseBranch }
      : {}),
    ...(overrides.remoteUrl !== undefined ? { remoteUrl: overrides.remoteUrl } : {}),
  };
}

// =============================================================================
// Test Utilities (browser-compatible)
// =============================================================================

/**
 * Promise-based delay utility.
 * Prefer waitFor patterns when checking conditions; use delay() only for fixed waits.
 *
 * This is in shared/test-fixtures (not services/test-utils) to be browser-compatible
 * for renderer tests that run in happy-dom environment.
 *
 * @param ms - Milliseconds to wait
 * @returns Promise that resolves after the delay
 */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
