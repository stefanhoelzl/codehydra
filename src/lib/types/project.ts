export type ProjectHandle = string;

export interface Workspace {
  name: string;
  path: string;
  /** Current branch name, or null if HEAD is detached */
  branch: string | null;
  port: number;
  url: string;
}

export interface Project {
  handle: ProjectHandle;
  path: string;
  workspaces: Workspace[];
}

export interface CodeServerInfo {
  port: number;
  url: string;
}

export interface BranchInfo {
  name: string;
  isRemote: boolean;
}
