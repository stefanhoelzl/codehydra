/**
 * Tests for API interface definitions.
 * Verifies interface structure through compile-time type checking.
 */
import { describe, it, expect } from "vitest";
import type { IProjectApi, IWorkspaceApi, IUiApi, ILifecycleApi } from "./interfaces";
import type {
  ProjectId,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  AgentSession,
} from "./types";
import type { UIMode } from "../ipc";

describe("IProjectApi Interface", () => {
  it("should have correct method signatures", () => {
    // Type-level test: this compiles if interface is correct
    const api: IProjectApi = {
      async open(path?: string): Promise<Project | null> {
        void path;
        throw new Error("mock");
      },
      async close(projectId: ProjectId): Promise<void> {
        void projectId;
      },
      async clone(url: string): Promise<Project> {
        void url;
        throw new Error("mock");
      },
      async fetchBases(projectId: ProjectId): Promise<{ readonly bases: readonly BaseInfo[] }> {
        void projectId;
        return { bases: [] };
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.open).toBe("function");
    expect(typeof api.close).toBe("function");
    expect(typeof api.fetchBases).toBe("function");
  });
});

describe("IWorkspaceApi Interface", () => {
  it("should have correct method signatures", () => {
    const api: IWorkspaceApi = {
      async create(
        projectId: ProjectId | undefined,
        name: string,
        base: string
      ): Promise<Workspace> {
        void projectId;
        void name;
        void base;
        throw new Error("mock");
      },
      async remove(
        workspacePath: string,
        options?: {
          keepBranch?: boolean;
          skipSwitch?: boolean;
          force?: boolean;
        }
      ): Promise<{ started: boolean }> {
        void workspacePath;
        void options;
        return { started: true };
      },
      async getStatus(workspacePath: string): Promise<WorkspaceStatus> {
        void workspacePath;
        return { isDirty: false, agent: { type: "none" } };
      },
      async setMetadata(workspacePath: string, key: string, value: string | null): Promise<void> {
        void workspacePath;
        void key;
        void value;
      },
      async getMetadata(workspacePath: string): Promise<Readonly<Record<string, string>>> {
        void workspacePath;
        return { base: "main" };
      },
      async getAgentSession(workspacePath: string): Promise<AgentSession | null> {
        void workspacePath;
        return null;
      },
      async restartAgentServer(workspacePath: string): Promise<number> {
        void workspacePath;
        return 14001;
      },
      async executeCommand(
        workspacePath: string,
        command: string,
        args?: readonly unknown[]
      ): Promise<unknown> {
        void workspacePath;
        void command;
        void args;
        return undefined;
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.create).toBe("function");
    expect(typeof api.remove).toBe("function");
    expect(typeof api.getStatus).toBe("function");
    expect(typeof api.setMetadata).toBe("function");
    expect(typeof api.getMetadata).toBe("function");
    expect(typeof api.getAgentSession).toBe("function");
    expect(typeof api.restartAgentServer).toBe("function");
    expect(typeof api.executeCommand).toBe("function");
  });
});

describe("IUiApi Interface", () => {
  it("should have correct method signatures", () => {
    const api: IUiApi = {
      async getActiveWorkspace(): Promise<WorkspaceRef | null> {
        return null;
      },
      async switchWorkspace(workspacePath: string, focus?: boolean): Promise<void> {
        void workspacePath;
        void focus;
      },
      async setMode(mode: UIMode): Promise<void> {
        void mode;
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.getActiveWorkspace).toBe("function");
    expect(typeof api.switchWorkspace).toBe("function");
    expect(typeof api.setMode).toBe("function");
  });
});

describe("ILifecycleApi Interface", () => {
  it("should have correct method signatures", () => {
    const api: ILifecycleApi = {
      async ready(): Promise<void> {
        // no-op
      },
      async quit(): Promise<void> {
        // no-op
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.ready).toBe("function");
    expect(typeof api.quit).toBe("function");
  });
});
