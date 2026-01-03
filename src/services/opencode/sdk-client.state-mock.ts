/**
 * Behavioral mock for SDK client following the mock.$ state pattern.
 *
 * Provides:
 * - Session state tracking with embedded status
 * - Prompt history recording
 * - Permission response recording
 * - Synchronous event emission for test predictability
 * - Custom matchers (toHaveSentPrompt, toHaveSession)
 *
 * Event emission is SYNCHRONOUS for test predictability. When `$.emitEvent()` is called,
 * it immediately resolves any pending iterator reads. This differs from the real SDK's
 * async SSE streams, but allows tests to control timing precisely. Real async behavior
 * is validated in boundary tests (`opencode-client.boundary.test.ts`).
 *
 * Matchers are auto-registered when this module is imported.
 */

import { expect } from "vitest";
import type {
  Session,
  Event as SdkEvent,
  SessionStatus as SdkSessionStatus,
} from "@opencode-ai/sdk";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherResult,
  MatcherImplementationsFor,
} from "../../test/state-mock";
import type { SdkClientFactory as OpenCodeSdkClientFactory } from "./opencode-client";

// Re-export SDK types for convenience
export type { Session, SdkEvent, SdkSessionStatus };

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Session with embedded status for mock state tracking.
 * Real SDK returns sessions and statuses separately; this combines them for simplicity.
 */
export interface MockSession extends Session {
  readonly status: SdkSessionStatus;
}

/**
 * Record of a prompt sent to a session.
 */
export interface PromptRecord {
  readonly sessionId: string;
  readonly prompt: string;
  readonly agent?: string;
  readonly model?: { providerID: string; modelID: string };
  readonly timestamp: number;
}

/**
 * Record of a permission response.
 */
export interface PermissionResponse {
  readonly sessionId: string;
  readonly permissionId: string;
  readonly response: "once" | "always" | "reject";
  readonly timestamp: number;
}

/**
 * Mock state interface - pure data, logic in matchers.
 */
export interface SdkClientMockState extends MockState {
  /** Map of session ID to session with embedded status */
  readonly sessions: ReadonlyMap<string, MockSession>;
  /** Whether the mock is connected (event stream active) */
  readonly connected: boolean;
  /** History of prompts sent */
  readonly prompts: readonly PromptRecord[];
  /** History of emitted events */
  readonly emittedEvents: readonly SdkEvent[];
  /** History of permission responses */
  readonly permissionResponses: readonly PermissionResponse[];

  /**
   * Emit an event to the stream synchronously.
   * Immediately resolves any pending iterator reads.
   */
  emitEvent(event: SdkEvent): void;

  /**
   * Complete the event stream gracefully.
   * Causes the async iterator to finish.
   */
  completeStream(): void;

  /**
   * Error the event stream.
   * Causes pending reads to reject with the error.
   */
  errorStream(error: Error): void;

  /**
   * Set a connection error that will cause subscribe() to reject.
   * Pass null to clear the error.
   */
  setConnectionError(error: Error | null): void;
}

/**
 * Mock SDK client type with state access.
 * Partial implementation of OpencodeClient focused on methods we use.
 */
export interface MockSdkClient extends MockWithState<SdkClientMockState> {
  session: {
    list(): Promise<{ data: Session[] }>;
    status(): Promise<{ data: Record<string, SdkSessionStatus> }>;
    create(args: { body: object }): Promise<{ data: Session }>;
    prompt(args: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text: string }>;
        agent?: string;
        model?: { providerID: string; modelID: string };
      };
    }): Promise<{ data: { id: string } }>;
    get(args: { path: { id: string } }): Promise<{ data: Session }>;
    delete(args: { path: { id: string } }): Promise<{ data: Session }>;
  };
  event: {
    subscribe(): Promise<{ stream: AsyncIterable<SdkEvent> }>;
  };
  postSessionIdPermissionsPermissionId(args: {
    path: { id: string; permissionId: string };
    body: { response: "once" | "always" | "reject" };
  }): Promise<void>;
}

/**
 * Factory function type for creating SDK clients.
 * Used for dependency injection in OpenCodeClient.
 */
export type SdkClientFactory = (baseUrl: string) => MockSdkClient;

/**
 * Factory options for creating a mock SDK client.
 */
export interface MockSdkClientOptions {
  /** Initial sessions with embedded status */
  readonly sessions?: Array<Partial<MockSession> & { id: string; directory: string }>;
  /** Connection error to throw on subscribe() */
  readonly connectionError?: Error;
  /** Error to throw on session.list() */
  readonly sessionListError?: Error;
  /** Error to throw on session.status() */
  readonly sessionStatusError?: Error;
}

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Internal state class implementing SdkClientMockState.
 */
class SdkClientMockStateImpl implements SdkClientMockState {
  private readonly _sessions: Map<string, MockSession>;
  private readonly _prompts: PromptRecord[] = [];
  private readonly _emittedEvents: SdkEvent[] = [];
  private readonly _permissionResponses: PermissionResponse[] = [];
  private _connected = false;
  private _connectionError: Error | null = null;
  private _sessionListError: Error | null = null;
  private _sessionStatusError: Error | null = null;

  // Event stream infrastructure
  private _eventQueue: SdkEvent[] = [];
  private _pendingResolve: ((result: IteratorResult<SdkEvent>) => void) | null = null;
  private _pendingReject: ((error: Error) => void) | null = null;
  private _streamDone = false;
  private _streamError: Error | null = null;

  // ID counter for session creation
  private _nextSessionId = 1;

  constructor(sessions: Map<string, MockSession>) {
    this._sessions = sessions;
  }

  get sessions(): ReadonlyMap<string, MockSession> {
    return this._sessions;
  }

  get connected(): boolean {
    return this._connected;
  }

  get prompts(): readonly PromptRecord[] {
    return this._prompts;
  }

  get emittedEvents(): readonly SdkEvent[] {
    return this._emittedEvents;
  }

  get permissionResponses(): readonly PermissionResponse[] {
    return this._permissionResponses;
  }

  // ---- Setup Methods ----

  emitEvent(event: SdkEvent): void {
    this._emittedEvents.push(event);

    // If there's a pending read, resolve it immediately
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject = null;
      resolve({ value: event, done: false });
    } else {
      // Queue the event for later consumption
      this._eventQueue.push(event);
    }
  }

  completeStream(): void {
    this._streamDone = true;
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject = null;
      resolve({ value: undefined as unknown as SdkEvent, done: true });
    }
  }

  errorStream(error: Error): void {
    this._streamError = error;
    if (this._pendingReject) {
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      reject(error);
    }
  }

  setConnectionError(error: Error | null): void {
    this._connectionError = error;
  }

  // ---- Internal Methods (called by mock) ----

  _getConnectionError(): Error | null {
    return this._connectionError;
  }

  _setConnected(connected: boolean): void {
    this._connected = connected;
  }

  _setSessionListError(error: Error | null): void {
    this._sessionListError = error;
  }

  _getSessionListError(): Error | null {
    return this._sessionListError;
  }

  _setSessionStatusError(error: Error | null): void {
    this._sessionStatusError = error;
  }

  _getSessionStatusError(): Error | null {
    return this._sessionStatusError;
  }

  _addSession(session: MockSession): void {
    this._sessions.set(session.id, session);
  }

  _removeSession(id: string): MockSession | undefined {
    const session = this._sessions.get(id);
    if (session) {
      this._sessions.delete(id);
    }
    return session;
  }

  _recordPrompt(record: PromptRecord): void {
    this._prompts.push(record);
  }

  _recordPermissionResponse(record: PermissionResponse): void {
    this._permissionResponses.push(record);
  }

  _generateSessionId(): string {
    const id = `ses-${String(this._nextSessionId++).padStart(4, "0")}`;
    return id;
  }

  /**
   * Create an async iterator for the event stream.
   */
  _createEventIterator(): AsyncIterable<SdkEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<SdkEvent>> => {
          // If there's a stream error, reject immediately
          if (this._streamError) {
            return Promise.reject(this._streamError);
          }

          // If there are queued events, return the next one
          if (this._eventQueue.length > 0) {
            return Promise.resolve({ value: this._eventQueue.shift()!, done: false });
          }

          // If stream is done, return done
          if (this._streamDone) {
            return Promise.resolve({ value: undefined as unknown as SdkEvent, done: true });
          }

          // Otherwise, wait for the next event
          return new Promise((resolve, reject) => {
            this._pendingResolve = resolve;
            this._pendingReject = reject;
          });
        },
      }),
    };
  }

  // ---- MockState Implementation ----

  snapshot(): Snapshot {
    return {
      __brand: "Snapshot" as const,
      value: this.toString(),
    };
  }

  toString(): string {
    const sessionCount = this._sessions.size;
    const sessionIds = Array.from(this._sessions.keys()).join(", ") || "(none)";
    const promptCount = this._prompts.length;
    const connected = this._connected ? "connected" : "disconnected";

    return `${sessionCount} session(s): ${sessionIds}, ${promptCount} prompt(s), ${connected}`;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a behavioral mock SDK client for testing.
 *
 * @example Basic usage
 * ```ts
 * const mock = createSdkClientMock();
 * const factory = createSdkFactoryMock(mock);
 * const client = new OpenCodeClient(8080, logger, factory);
 * ```
 *
 * @example With initial sessions
 * ```ts
 * const mock = createSdkClientMock({
 *   sessions: [
 *     { id: 'ses-0001', directory: '/test', status: { type: 'idle' } },
 *   ],
 * });
 * ```
 *
 * @example Emit events synchronously
 * ```ts
 * // Events are delivered immediately for test predictability
 * mock.$.emitEvent({ type: 'session.status', properties: { ... } });
 * // Assertions can be made immediately without awaiting
 * expect(client.currentStatus).toBe('busy');
 * ```
 */
export function createSdkClientMock(options?: MockSdkClientOptions): MockSdkClient {
  // Build initial sessions map with defaults
  const sessionsMap = new Map<string, MockSession>();

  if (options?.sessions) {
    for (const sessionInput of options.sessions) {
      const session: MockSession = {
        id: sessionInput.id,
        directory: sessionInput.directory,
        title: sessionInput.title ?? "Test Session",
        projectID: sessionInput.projectID ?? "proj-test",
        version: sessionInput.version ?? "1",
        time: sessionInput.time ?? { created: Date.now(), updated: Date.now() },
        status: sessionInput.status ?? { type: "idle" },
        ...(sessionInput.parentID !== undefined && { parentID: sessionInput.parentID }),
      };
      sessionsMap.set(session.id, session);
    }
  }

  // Create state
  const state = new SdkClientMockStateImpl(sessionsMap);

  // Set initial errors if provided
  if (options?.connectionError) {
    state.setConnectionError(options.connectionError);
  }
  if (options?.sessionListError) {
    state._setSessionListError(options.sessionListError);
  }
  if (options?.sessionStatusError) {
    state._setSessionStatusError(options.sessionStatusError);
  }

  // Create mock client
  const mock: MockSdkClient = {
    $: state,

    session: {
      async list(): Promise<{ data: Session[] }> {
        const error = state._getSessionListError();
        if (error) {
          throw error;
        }
        // Return sessions without the status field (SDK returns them separately)
        const sessions = Array.from(state.sessions.values()).map((s) => {
          const { status: _status, ...session } = s;
          return session;
        });
        return { data: sessions };
      },

      async status(): Promise<{ data: Record<string, SdkSessionStatus> }> {
        const error = state._getSessionStatusError();
        if (error) {
          throw error;
        }
        const statuses: Record<string, SdkSessionStatus> = {};
        for (const [id, session] of state.sessions) {
          statuses[id] = session.status;
        }
        return { data: statuses };
      },

      async create(_args: { body: object }): Promise<{ data: Session }> {
        const id = state._generateSessionId();
        const session: MockSession = {
          id,
          directory: "",
          title: "New Session",
          projectID: "proj-test",
          version: "1",
          time: { created: Date.now(), updated: Date.now() },
          status: { type: "idle" },
        };
        state._addSession(session);

        const { status: _status, ...sessionWithoutStatus } = session;
        return { data: sessionWithoutStatus };
      },

      async prompt(args: {
        path: { id: string };
        body: {
          parts: Array<{ type: string; text: string }>;
          agent?: string;
          model?: { providerID: string; modelID: string };
        };
      }): Promise<{ data: { id: string } }> {
        const sessionId = args.path.id;
        const text = args.body.parts.find((p) => p.type === "text")?.text ?? "";

        const record: PromptRecord = {
          sessionId,
          prompt: text,
          timestamp: Date.now(),
        };
        if (args.body.agent !== undefined) {
          (record as { agent: string }).agent = args.body.agent;
        }
        if (args.body.model !== undefined) {
          (record as { model: { providerID: string; modelID: string } }).model = args.body.model;
        }
        state._recordPrompt(record);

        return { data: { id: `msg-${Date.now()}` } };
      },

      async get(args: { path: { id: string } }): Promise<{ data: Session }> {
        const session = state.sessions.get(args.path.id);
        if (!session) {
          throw new Error(`Session not found: ${args.path.id}`);
        }
        const { status: _status, ...sessionWithoutStatus } = session;
        return { data: sessionWithoutStatus };
      },

      async delete(args: { path: { id: string } }): Promise<{ data: Session }> {
        const session = state._removeSession(args.path.id);
        if (!session) {
          throw new Error(`Session not found: ${args.path.id}`);
        }
        const { status: _status, ...sessionWithoutStatus } = session;
        return { data: sessionWithoutStatus };
      },
    },

    event: {
      async subscribe(): Promise<{ stream: AsyncIterable<SdkEvent> }> {
        const connectionError = state._getConnectionError();
        if (connectionError) {
          throw connectionError;
        }

        state._setConnected(true);
        return { stream: state._createEventIterator() };
      },
    },

    async postSessionIdPermissionsPermissionId(args: {
      path: { id: string; permissionId: string };
      body: { response: "once" | "always" | "reject" };
    }): Promise<void> {
      state._recordPermissionResponse({
        sessionId: args.path.id,
        permissionId: args.path.permissionId,
        response: args.body.response,
        timestamp: Date.now(),
      });
    },
  };

  return mock;
}

/**
 * Create a factory function that returns the provided mock client.
 *
 * @example
 * ```ts
 * const mock = createSdkClientMock({ sessions: [...] });
 * const factory = createSdkFactoryMock(mock);
 * const client = new OpenCodeClient(8080, logger, factory);
 * ```
 */
export function createSdkFactoryMock(mock: MockSdkClient): SdkClientFactory {
  return (_baseUrl: string) => mock;
}

/**
 * Helper to cast a mock factory to the OpenCodeClient factory type.
 * Use this when injecting the mock into OpenCodeClient or OpenCodeProvider.
 *
 * @example
 * ```ts
 * const mock = createSdkClientMock();
 * const factory = asSdkFactory(createSdkFactoryMock(mock));
 * const client = new OpenCodeClient(8080, logger, factory);
 * ```
 */
export function asSdkFactory(factory: SdkClientFactory): OpenCodeSdkClientFactory {
  return factory as unknown as OpenCodeSdkClientFactory;
}

// =============================================================================
// Custom Matchers
// =============================================================================

/** Custom matchers for MockSdkClient assertions. */
interface SdkClientMatchers {
  /**
   * Assert that a prompt was sent to a session.
   * @param sessionId - The session ID to check
   * @param text - Optional text to match (string for exact match, RegExp for pattern)
   */
  toHaveSentPrompt(sessionId: string, text?: string | RegExp): void;

  /**
   * Assert that a session exists in the mock state.
   * @param sessionId - The session ID to check
   */
  toHaveSession(sessionId: string): void;

  /**
   * Assert that the mock is connected (event stream active).
   */
  toBeConnected(): void;
}

// Module augmentation for vitest
declare module "vitest" {
  interface Assertion<T> extends SdkClientMatchers {}
}

/** Matcher implementations. */
export const sdkClientMatchers: MatcherImplementationsFor<MockSdkClient, SdkClientMatchers> = {
  toHaveSentPrompt(received, sessionId, text?) {
    const prompts = received.$.prompts.filter((p) => p.sessionId === sessionId);

    let pass: boolean;
    let matchDetails: string;

    if (text === undefined) {
      // Just check if any prompt was sent to this session
      pass = prompts.length > 0;
      matchDetails = `any prompt to session ${sessionId}`;
    } else if (typeof text === "string") {
      // Exact string match
      pass = prompts.some((p) => p.prompt === text);
      matchDetails = `prompt "${text}" to session ${sessionId}`;
    } else {
      // RegExp match
      pass = prompts.some((p) => text.test(p.prompt));
      matchDetails = `prompt matching ${text} to session ${sessionId}`;
    }

    const promptsDesc =
      prompts.length > 0 ? prompts.map((p) => `"${p.prompt}"`).join(", ") : "(none)";

    return {
      pass,
      message: (): string =>
        pass
          ? `Expected not to have sent ${matchDetails}, but did. Prompts: ${promptsDesc}`
          : `Expected to have sent ${matchDetails}. Prompts sent to session: ${promptsDesc}`,
    } satisfies MatcherResult;
  },

  toHaveSession(received, sessionId) {
    const hasSession = received.$.sessions.has(sessionId);
    const sessionIds = Array.from(received.$.sessions.keys()).join(", ") || "(none)";

    return {
      pass: hasSession,
      message: (): string =>
        hasSession
          ? `Expected not to have session ${sessionId}, but did. Sessions: ${sessionIds}`
          : `Expected to have session ${sessionId}. Sessions: ${sessionIds}`,
    } satisfies MatcherResult;
  },

  toBeConnected(received) {
    const isConnected = received.$.connected;

    return {
      pass: isConnected,
      message: (): string =>
        isConnected
          ? `Expected mock not to be connected, but it is`
          : `Expected mock to be connected, but it is not`,
    } satisfies MatcherResult;
  },
};

// Auto-register matchers when this module is imported
expect.extend(sdkClientMatchers);

// =============================================================================
// Helper Functions (for backward compatibility during migration)
// =============================================================================

/**
 * Helper to create a test session object.
 * Matches the interface expected by the mock.
 */
export function createTestSession(
  overrides: Partial<MockSession> & { id: string; directory: string }
): MockSession {
  return {
    id: overrides.id,
    directory: overrides.directory,
    title: overrides.title ?? "Test Session",
    projectID: overrides.projectID ?? "proj-test",
    version: overrides.version ?? "1",
    time: overrides.time ?? { created: Date.now(), updated: Date.now() },
    status: overrides.status ?? { type: "idle" },
    ...(overrides.parentID !== undefined && { parentID: overrides.parentID }),
  };
}

/**
 * Helper to create a session status event.
 */
export function createSessionStatusEvent(
  sessionID: string,
  status: SdkSessionStatus
): SdkEvent & { type: "session.status" } {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status,
    },
  };
}

/**
 * Helper to create a session.created event.
 */
export function createSessionCreatedEvent(
  session: Session
): SdkEvent & { type: "session.created" } {
  return {
    type: "session.created",
    properties: {
      info: session,
    },
  };
}

/**
 * Helper to create a session.idle event.
 */
export function createSessionIdleEvent(sessionID: string): SdkEvent & { type: "session.idle" } {
  return {
    type: "session.idle",
    properties: {
      sessionID,
    },
  };
}

/**
 * Helper to create a session.deleted event.
 */
export function createSessionDeletedEvent(
  session: Session
): SdkEvent & { type: "session.deleted" } {
  return {
    type: "session.deleted",
    properties: {
      info: session,
    },
  };
}

/**
 * Helper to create a permission.updated event.
 */
export function createPermissionUpdatedEvent(permission: {
  id: string;
  sessionID: string;
  type: string;
  title: string;
  messageID?: string;
}): SdkEvent & { type: "permission.updated" } {
  return {
    type: "permission.updated",
    properties: {
      id: permission.id,
      sessionID: permission.sessionID,
      type: permission.type,
      title: permission.title,
      messageID: permission.messageID ?? "msg-1",
      metadata: {},
      time: { created: Date.now() },
    },
  };
}

/**
 * Helper to create a permission.replied event.
 */
export function createPermissionRepliedEvent(
  sessionID: string,
  permissionID: string,
  response: "once" | "always" | "reject"
): SdkEvent & { type: "permission.replied" } {
  return {
    type: "permission.replied",
    properties: {
      sessionID,
      permissionID,
      response,
    },
  };
}
