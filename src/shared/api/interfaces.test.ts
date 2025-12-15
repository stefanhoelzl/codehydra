/**
 * Tests for API interface definitions.
 * Verifies interface structure through compile-time type checking.
 */
import { describe, it, expect } from "vitest";
import type {
  IProjectApi,
  IWorkspaceApi,
  IUiApi,
  ILifecycleApi,
  ICodeHydraApi,
  ICoreApi,
  ApiEvents,
  Unsubscribe,
} from "./interfaces";
import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  WorkspaceRemovalResult,
  SetupResult,
  SetupProgress,
  AppState,
} from "./types";
import type { UIMode, UIModeChangedEvent } from "../ipc";

describe("IProjectApi Interface", () => {
  it("should have correct method signatures", () => {
    // Type-level test: this compiles if interface is correct
    const api: IProjectApi = {
      async open(path: string): Promise<Project> {
        void path;
        throw new Error("mock");
      },
      async close(projectId: ProjectId): Promise<void> {
        void projectId;
      },
      async list(): Promise<readonly Project[]> {
        return [];
      },
      async get(projectId: ProjectId): Promise<Project | undefined> {
        void projectId;
        return undefined;
      },
      async fetchBases(projectId: ProjectId): Promise<{ readonly bases: readonly BaseInfo[] }> {
        void projectId;
        return { bases: [] };
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.open).toBe("function");
    expect(typeof api.close).toBe("function");
    expect(typeof api.list).toBe("function");
    expect(typeof api.get).toBe("function");
    expect(typeof api.fetchBases).toBe("function");
  });
});

describe("IWorkspaceApi Interface", () => {
  it("should have correct method signatures", () => {
    const api: IWorkspaceApi = {
      async create(projectId: ProjectId, name: string, base: string): Promise<Workspace> {
        void projectId;
        void name;
        void base;
        throw new Error("mock");
      },
      async remove(
        projectId: ProjectId,
        workspaceName: WorkspaceName,
        keepBranch?: boolean
      ): Promise<WorkspaceRemovalResult> {
        void projectId;
        void workspaceName;
        void keepBranch;
        return { branchDeleted: false };
      },
      async get(
        projectId: ProjectId,
        workspaceName: WorkspaceName
      ): Promise<Workspace | undefined> {
        void projectId;
        void workspaceName;
        return undefined;
      },
      async getStatus(
        projectId: ProjectId,
        workspaceName: WorkspaceName
      ): Promise<WorkspaceStatus> {
        void projectId;
        void workspaceName;
        return { isDirty: false, agent: { type: "none" } };
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.create).toBe("function");
    expect(typeof api.remove).toBe("function");
    expect(typeof api.get).toBe("function");
    expect(typeof api.getStatus).toBe("function");
  });
});

describe("IUiApi Interface", () => {
  it("should have correct method signatures", () => {
    const api: IUiApi = {
      async selectFolder(): Promise<string | null> {
        return null;
      },
      async getActiveWorkspace(): Promise<WorkspaceRef | null> {
        return null;
      },
      async switchWorkspace(
        projectId: ProjectId,
        workspaceName: WorkspaceName,
        focus?: boolean
      ): Promise<void> {
        void projectId;
        void workspaceName;
        void focus;
      },
      async setDialogMode(isOpen: boolean): Promise<void> {
        void isOpen;
      },
      async focusActiveWorkspace(): Promise<void> {
        // no-op
      },
      async setMode(mode: UIMode): Promise<void> {
        void mode;
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.selectFolder).toBe("function");
    expect(typeof api.getActiveWorkspace).toBe("function");
    expect(typeof api.switchWorkspace).toBe("function");
    expect(typeof api.setDialogMode).toBe("function");
    expect(typeof api.focusActiveWorkspace).toBe("function");
    expect(typeof api.setMode).toBe("function");
  });
});

describe("ILifecycleApi Interface", () => {
  it("should have correct method signatures", () => {
    const api: ILifecycleApi = {
      async getState(): Promise<AppState> {
        return "ready";
      },
      async setup(): Promise<SetupResult> {
        return { success: true };
      },
      async quit(): Promise<void> {
        // no-op
      },
    };

    expect(api).toBeDefined();
    expect(typeof api.getState).toBe("function");
    expect(typeof api.setup).toBe("function");
    expect(typeof api.quit).toBe("function");
  });
});

describe("ApiEvents Interface", () => {
  it("should define all required event handlers", () => {
    // Type-level test: assign functions to event handler types
    const handlers: ApiEvents = {
      "project:opened": (event: { readonly project: Project }) => {
        void event;
      },
      "project:closed": (event: { readonly projectId: ProjectId }) => {
        void event;
      },
      "project:bases-updated": (event: {
        readonly projectId: ProjectId;
        readonly bases: readonly BaseInfo[];
      }) => {
        void event;
      },
      "workspace:created": (event: {
        readonly projectId: ProjectId;
        readonly workspace: Workspace;
      }) => {
        void event;
      },
      "workspace:removed": (event: WorkspaceRef) => {
        void event;
      },
      "workspace:switched": (event: WorkspaceRef | null) => {
        void event;
      },
      "workspace:status-changed": (event: WorkspaceRef & { readonly status: WorkspaceStatus }) => {
        void event;
      },
      "ui:mode-changed": (event: UIModeChangedEvent) => {
        void event;
      },
      "setup:progress": (event: SetupProgress) => {
        void event;
      },
    };

    expect(handlers).toBeDefined();
    expect(Object.keys(handlers)).toHaveLength(9);
  });
});

describe("ICodeHydraApi Interface", () => {
  it("should extend IDisposable", () => {
    // Type-level test: ICodeHydraApi should have dispose()
    const mockApi = {
      projects: {} as IProjectApi,
      workspaces: {} as IWorkspaceApi,
      ui: {} as IUiApi,
      lifecycle: {} as ILifecycleApi,
      on(): Unsubscribe {
        return () => {};
      },
      dispose(): void {},
    } satisfies ICodeHydraApi;

    expect(mockApi).toBeDefined();
    expect(typeof mockApi.dispose).toBe("function");
  });

  it("should have all domain API sub-interfaces", () => {
    const mockApi = {
      projects: {} as IProjectApi,
      workspaces: {} as IWorkspaceApi,
      ui: {} as IUiApi,
      lifecycle: {} as ILifecycleApi,
      on(): Unsubscribe {
        return () => {};
      },
      dispose(): void {},
    } satisfies ICodeHydraApi;

    expect(mockApi.projects).toBeDefined();
    expect(mockApi.workspaces).toBeDefined();
    expect(mockApi.ui).toBeDefined();
    expect(mockApi.lifecycle).toBeDefined();
  });

  it("should have typed on() method for event subscription", () => {
    const mockApi: ICodeHydraApi = {
      projects: {} as IProjectApi,
      workspaces: {} as IWorkspaceApi,
      ui: {} as IUiApi,
      lifecycle: {} as ILifecycleApi,
      on(): Unsubscribe {
        return () => {};
      },
      dispose(): void {},
    };

    // Test type safety of event subscription
    const unsub = mockApi.on("project:opened", (event) => {
      // TypeScript should infer event type correctly
      const project: Project = event.project;
      void project;
    });

    expect(typeof unsub).toBe("function");
  });
});

describe("ICoreApi Type", () => {
  it("should be a subset excluding UI and lifecycle", () => {
    // ICoreApi should have: projects, workspaces, on, dispose
    // ICoreApi should NOT have: ui, lifecycle
    const coreApi: ICoreApi = {
      projects: {} as IProjectApi,
      workspaces: {} as IWorkspaceApi,
      on(): Unsubscribe {
        return () => {};
      },
      dispose(): void {},
    };

    expect(coreApi).toBeDefined();
    expect(coreApi.projects).toBeDefined();
    expect(coreApi.workspaces).toBeDefined();
    expect(coreApi.on).toBeDefined();
    expect(coreApi.dispose).toBeDefined();

    // Type-level check: ICoreApi should not have ui or lifecycle
    // @ts-expect-error - ICoreApi should not have ui property
    void coreApi.ui;
    // @ts-expect-error - ICoreApi should not have lifecycle property
    void coreApi.lifecycle;
  });
});
