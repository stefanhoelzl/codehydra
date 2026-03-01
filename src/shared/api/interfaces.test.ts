/**
 * Tests for API event type definitions.
 * Verifies event structure through compile-time type checking.
 */
import { describe, it, expect } from "vitest";
import type { ApiEvents } from "./interfaces";
import type {
  ProjectId,
  WorkspaceName,
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  BaseInfo,
  SetupScreenProgress,
} from "./types";
import type { UIModeChangedEvent, SetupErrorPayload } from "../ipc";

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
      "workspace:metadata-changed": (event: {
        readonly projectId: ProjectId;
        readonly workspaceName: WorkspaceName;
        readonly key: string;
        readonly value: string | null;
      }) => {
        void event;
      },
      "ui:mode-changed": (event: UIModeChangedEvent) => {
        void event;
      },
      "lifecycle:setup-progress": (event: SetupScreenProgress) => {
        void event;
      },
      "lifecycle:setup-error": (event: SetupErrorPayload) => {
        void event;
      },
    };

    expect(handlers).toBeDefined();
    expect(Object.keys(handlers)).toHaveLength(11);
  });
});
