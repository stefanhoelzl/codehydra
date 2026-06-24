/**
 * Compile-time drift guard between the shared types (the source of truth the
 * CodeHydra server compiles against) and `api.d.ts` (the self-contained,
 * copyable type declarations published to third-party extensions).
 *
 * `api.d.ts` must stay standalone so third parties can copy it, which means it
 * cannot import the shared types. These assertions make `pnpm check:extensions`
 * fail instead when the two declarations drift apart:
 * - Server → client payloads: what the server sends must satisfy what api.d.ts declares.
 * - Client → server payloads: what api.d.ts lets third parties build must satisfy the wire types.
 *
 * When adding a public type to api.d.ts, add an assertion here.
 * This file is type-only: it is checked by tsc but never imported or bundled.
 */
import type * as shared from "../../../src/shared/api/types";
import type { WorkspaceCreateRequest, LogContext } from "../../../src/shared/plugin-protocol";
import type * as api from "../api";

type Expect<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
type MutuallyExtends<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = MutuallyExtends<keyof A, keyof B>;

// Server → client payloads. Asserted in both directions where no branded types
// are involved, so both extra and missing fields in api.d.ts are caught.
export type WorkspaceStatusMatches = Expect<
  MutuallyExtends<shared.WorkspaceStatus, api.WorkspaceStatus>
>;
export type AgentStatusMatches = Expect<MutuallyExtends<shared.AgentStatus, api.AgentStatus>>;
export type AgentStatusCountsMatch = Expect<
  MutuallyExtends<shared.AgentStatusCounts, api.AgentStatusCounts>
>;
export type AgentSessionMatches = Expect<MutuallyExtends<shared.AgentSession, api.AgentSession>>;
export type WorkspaceTagMatches = Expect<MutuallyExtends<shared.WorkspaceTag, api.WorkspaceTag>>;

// shared.Workspace uses branded string types (ProjectId, WorkspaceName), so the
// declared type cannot extend the shared one; assert the sent→declared direction
// plus exact key parity to still catch missing or extra fields.
export type WorkspaceMatches = Expect<Extends<shared.Workspace, api.Workspace>>;
export type WorkspaceKeysMatch = Expect<SameKeys<shared.Workspace, api.Workspace>>;

// Client → server payloads.
export type AgentSpecMatches = Expect<MutuallyExtends<api.AgentSpec, shared.AgentSpec>>;
export type PromptModelMatches = Expect<MutuallyExtends<api.PromptModel, shared.PromptModel>>;
export type LogContextMatches = Expect<MutuallyExtends<api.LogContext, LogContext>>;
export type WorkspaceCreateOptionsMatch = Expect<
  MutuallyExtends<api.WorkspaceCreateOptions, Pick<WorkspaceCreateRequest, "agent" | "stealFocus">>
>;
