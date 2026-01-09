/**
 * WorkspaceFileService - creates and manages .code-workspace files.
 *
 * Files are stored at: <projectWorkspacesDir>/<name>.code-workspace
 * (alongside workspace folders at <projectWorkspacesDir>/<name>/)
 */

import type { FileSystemLayer } from "../platform/filesystem";
import type { Logger } from "../logging";
import { Path } from "../platform/path";
import type { IWorkspaceFileService, WorkspaceFileConfig, CodeWorkspaceFile } from "./types";

/**
 * Service that creates and manages .code-workspace files for workspaces.
 */
export class WorkspaceFileService implements IWorkspaceFileService {
  constructor(
    private readonly fileSystem: FileSystemLayer,
    private readonly config: WorkspaceFileConfig,
    private readonly logger: Logger
  ) {}

  async ensureWorkspaceFile(
    workspacePath: Path,
    projectWorkspacesDir: Path,
    agentSettings?: Readonly<Record<string, unknown>>
  ): Promise<Path> {
    // Always write the file - agent settings (like bridge port) may have changed
    return this.createWorkspaceFile(workspacePath, projectWorkspacesDir, agentSettings);
  }

  async createWorkspaceFile(
    workspacePath: Path,
    projectWorkspacesDir: Path,
    agentSettings?: Readonly<Record<string, unknown>>
  ): Promise<Path> {
    const workspaceName = workspacePath.basename;
    const workspaceFilePath = this.getWorkspaceFilePath(workspaceName, projectWorkspacesDir);

    // Build the workspace file content
    const content: CodeWorkspaceFile = {
      folders: [
        {
          // Use absolute path for the folder
          path: workspacePath.toString(),
        },
      ],
      settings: {
        ...this.config.defaultSettings,
        ...agentSettings,
      },
      ...(this.config.recommendedExtensions &&
        this.config.recommendedExtensions.length > 0 && {
          extensions: {
            recommendations: this.config.recommendedExtensions,
          },
        }),
    };

    // Write the file
    await this.fileSystem.writeFile(workspaceFilePath, JSON.stringify(content, null, 2));

    this.logger.debug("Created workspace file", {
      workspaceName,
      path: workspaceFilePath.toString(),
    });

    return workspaceFilePath;
  }

  getWorkspaceFilePath(workspaceName: string, projectWorkspacesDir: Path): Path {
    return new Path(projectWorkspacesDir, `${workspaceName}.code-workspace`);
  }

  async deleteWorkspaceFile(workspaceName: string, projectWorkspacesDir: Path): Promise<void> {
    const workspaceFilePath = this.getWorkspaceFilePath(workspaceName, projectWorkspacesDir);

    try {
      await this.fileSystem.rm(workspaceFilePath, { force: true });
      this.logger.debug("Deleted workspace file", {
        workspaceName,
        path: workspaceFilePath.toString(),
      });
    } catch (error) {
      // Log but don't throw - file might not exist or be already deleted
      this.logger.debug("Failed to delete workspace file", {
        workspaceName,
        path: workspaceFilePath.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
