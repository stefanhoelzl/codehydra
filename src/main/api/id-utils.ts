/**
 * ID generation utilities for CodeHydra API.
 *
 * Provides deterministic ID generation for projects, workspace name extraction,
 * and project resolution utilities.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { type ProjectId, type WorkspaceName } from "../../shared/api/types";

/**
 * Generate a deterministic ProjectId from an absolute path.
 *
 * The ID format is: `<safe-name>-<8-char-hex-hash>`
 * - safe-name: basename with special characters replaced by dashes
 * - hash: first 8 characters of SHA-256 hash of normalized path
 *
 * @param absolutePath Absolute path to the project directory
 * @returns A deterministic ProjectId
 *
 * @example
 * ```typescript
 * generateProjectId("/home/user/projects/my-app") // "my-app-12345678"
 * generateProjectId("/home/user/My Cool App")     // "My-Cool-App-abcdef12"
 * ```
 */
export function generateProjectId(absolutePath: string): ProjectId {
  // Normalize the path (handles double slashes, dot segments)
  // Also remove trailing slashes for consistent hashing
  let normalizedPath = path.normalize(absolutePath);
  if (normalizedPath.length > 1 && normalizedPath.endsWith(path.sep)) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  // Get basename
  const basename = path.basename(normalizedPath);

  // Create safe name:
  // 1. Replace non-alphanumeric characters with dashes
  // 2. Collapse consecutive dashes
  // 3. Remove leading/trailing dashes
  // 4. Use "root" as fallback for empty result
  const safeName =
    basename
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "root";

  // Generate hash from normalized path
  const hash = crypto.createHash("sha256").update(normalizedPath).digest("hex").slice(0, 8);

  return `${safeName}-${hash}` as ProjectId;
}

/**
 * Extract the workspace name from a workspace path.
 * The workspace name is the basename of the path.
 *
 * @param workspacePath Absolute path to the workspace directory
 * @returns The workspace name (basename of the path)
 *
 * @example
 * ```typescript
 * extractWorkspaceName("/home/user/projects/.worktrees/feature-1") // "feature-1"
 * ```
 */
export function extractWorkspaceName(workspacePath: string): WorkspaceName {
  return path.basename(workspacePath) as WorkspaceName;
}

/**
 * Interface for project list accessor.
 * Used for resolving project paths from IDs.
 */
export interface ProjectListAccessor {
  getAllProjects(): Promise<ReadonlyArray<{ path: string }>>;
}

/**
 * Resolve a project path from a project ID.
 * Searches through all projects to find one matching the given ID.
 *
 * @param projectId The project ID to resolve
 * @param accessor Object providing getAllProjects method
 * @returns The project path or undefined if not found
 *
 * @example
 * ```typescript
 * const path = await resolveProjectPath("my-app-12345678", appState);
 * if (path) {
 *   // Use the resolved path
 * }
 * ```
 */
export async function resolveProjectPath(
  projectId: ProjectId,
  accessor: ProjectListAccessor
): Promise<string | undefined> {
  const projects = await accessor.getAllProjects();
  for (const project of projects) {
    if (generateProjectId(project.path) === projectId) {
      return project.path;
    }
  }
  return undefined;
}

// =============================================================================
// Workspace Resolution Types
// =============================================================================

/**
 * Internal workspace representation for resolution.
 */
export interface InternalWorkspace {
  readonly path: string;
  readonly branch?: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Internal project representation for resolution.
 */
export interface InternalProject {
  readonly path: string;
  readonly name: string;
  readonly workspaces: ReadonlyArray<InternalWorkspace>;
}

/**
 * Interface for workspace resolution accessor.
 * Provides methods needed to resolve workspaces from IDs.
 */
export interface WorkspaceAccessor extends ProjectListAccessor {
  getProject(projectPath: string): InternalProject | undefined;
}

/**
 * Resolved workspace result with project context.
 * Used internally for workspace resolution in the main process.
 */
export interface InternalResolvedWorkspace {
  readonly projectPath: string;
  readonly project: InternalProject;
  readonly workspace: InternalWorkspace;
}

/**
 * Payload for workspace resolution.
 */
export interface WorkspaceRefPayload {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
}

/**
 * Resolve a workspace from project ID and workspace name.
 * Throws if not found.
 *
 * @param payload The workspace reference (projectId + workspaceName)
 * @param accessor Object providing project resolution methods
 * @returns Resolved workspace with project context
 * @throws Error if project or workspace not found
 */
export async function resolveWorkspace(
  payload: WorkspaceRefPayload,
  accessor: WorkspaceAccessor
): Promise<InternalResolvedWorkspace> {
  const projectPath = await resolveProjectPath(payload.projectId, accessor);
  if (!projectPath) {
    throw new Error(`Project not found: ${payload.projectId}`);
  }

  const project = accessor.getProject(projectPath);
  if (!project) {
    throw new Error(`Project not found: ${payload.projectId}`);
  }

  const workspace = project.workspaces.find(
    (w) => extractWorkspaceName(w.path) === payload.workspaceName
  );
  if (!workspace) {
    throw new Error(`Workspace not found: ${payload.workspaceName}`);
  }

  return { projectPath, project, workspace };
}

/**
 * Try to resolve a workspace from project ID and workspace name.
 * Returns undefined if not found (does not throw).
 *
 * @param payload The workspace reference (projectId + workspaceName)
 * @param accessor Object providing project resolution methods
 * @returns Resolved workspace with project context, or undefined if not found
 */
export async function tryResolveWorkspace(
  payload: WorkspaceRefPayload,
  accessor: WorkspaceAccessor
): Promise<InternalResolvedWorkspace | undefined> {
  const projectPath = await resolveProjectPath(payload.projectId, accessor);
  if (!projectPath) return undefined;

  const project = accessor.getProject(projectPath);
  if (!project) return undefined;

  const workspace = project.workspaces.find(
    (w) => extractWorkspaceName(w.path) === payload.workspaceName
  );
  if (!workspace) return undefined;

  return { projectPath, project, workspace };
}
