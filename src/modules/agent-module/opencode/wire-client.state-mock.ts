/**
 * Behavioral mock for the OpenCode wire client following the mock.$ state pattern.
 *
 * Implements the WireClient seam (wire.ts) — normalized calls and events — so
 * the same mock serves tests of either server API: the wires themselves are
 * what boundary tests run against real servers.
 *
 * Provides:
 * - Session state tracking with embedded status
 * - Prompt history recording
 * - Synchronous event emission for test predictability
 * - Custom matchers (toHaveSentPrompt, toHaveWireSession, toBeConnected)
 *
 * Event emission is SYNCHRONOUS for test predictability: when `$.emitEvent()`
 * is called, the connected listeners see it before the call returns. Real
 * stream behavior is validated in boundary tests (client.boundary.test.ts,
 * client-v2.boundary.test.ts).
 *
 * Matchers are auto-registered when this module is imported.
 */

import { expect } from "vitest";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherResult,
  MatcherImplementationsFor,
} from "../../../test/state-mock";
import { createSnapshot } from "../../../test/state-mock";
import { OpenCodeError } from "../../../shared/errors/service-errors";
import { ok, err, type Result, type Session, type ClientStatus } from "./types";
import type {
  WireClient,
  WireClientFactory,
  WireEvent,
  WirePromptOptions,
  WireSessionStatus,
} from "./wire";

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Session with embedded status for mock state tracking.
 * The real wires return sessions and statuses separately; this combines them.
 */
export interface MockSession extends Session {
  readonly status: { readonly type: WireSessionStatus };
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
  /** Queued (`sendPromptAsync`): recorded without waiting for any turn. */
  readonly queued?: true;
}

/**
 * Mock state interface - pure data, logic in matchers.
 */
export interface WireClientMockState extends MockState {
  /** Map of session ID to session with embedded status */
  readonly sessions: ReadonlyMap<string, MockSession>;
  /** Whether the mock is connected (event stream active) */
  readonly connected: boolean;
  /** History of prompts sent */
  readonly prompts: readonly PromptRecord[];
  /** History of emitted events */
  readonly emittedEvents: readonly WireEvent[];
  /** History of model/agent switches (2.x prompts switch on the session). */
  readonly switchCalls: ReadonlyArray<{
    readonly sessionId: string;
    readonly agent?: string;
    readonly model?: { providerID: string; modelID: string };
  }>;

  /**
   * Emit an event to the connected listeners synchronously.
   */
  emitEvent(event: WireEvent): void;

  /** Make the next listSessions() call fail. */
  setListError(error: Error | null): void;
  /** Make the next getStatus() call fail. */
  setStatusError(error: Error | null): void;
  /** Make connect() reject. */
  setConnectError(error: Error | null): void;
}

/**
 * Mock wire client type with state access.
 */
export interface MockWireClient extends MockWithState<WireClientMockState>, WireClient {}

/**
 * Factory function type for creating wire clients.
 * Used for dependency injection in OpenCodeClient.
 */
export type WireClientFactoryForMock = WireClientFactory;

/**
 * Factory options for creating a mock wire client.
 */
export interface MockWireClientOptions {
  /** Initial sessions with embedded status */
  readonly sessions?: Array<Partial<MockSession> & { id: string; directory: string }>;
  /** Error to throw from connect() */
  readonly connectError?: Error;
  /** Error to throw from listSessions() */
  readonly listError?: Error;
  /** Error to throw from getStatus() */
  readonly statusError?: Error;
}

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Internal state class implementing WireClientMockState.
 */
class WireClientMockStateImpl implements WireClientMockState {
  private readonly _sessions: Map<string, MockSession>;
  private readonly _prompts: PromptRecord[] = [];
  private readonly _emittedEvents: WireEvent[] = [];
  private readonly _switchCalls: Array<{
    sessionId: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
  }> = [];
  private _connected = false;
  private _connectError: Error | null = null;
  private _listError: Error | null = null;
  private _statusError: Error | null = null;
  private readonly _listeners = new Set<(event: WireEvent) => void>();

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

  get emittedEvents(): readonly WireEvent[] {
    return this._emittedEvents;
  }

  get switchCalls(): ReadonlyArray<{
    sessionId: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
  }> {
    return this._switchCalls;
  }

  // ---- Setup Methods ----

  emitEvent(event: WireEvent): void {
    this._emittedEvents.push(event);
    for (const listener of this._listeners) {
      listener(event);
    }
  }

  setConnectError(error: Error | null): void {
    this._connectError = error;
  }

  setListError(error: Error | null): void {
    this._listError = error;
  }

  setStatusError(error: Error | null): void {
    this._statusError = error;
  }

  // ---- Internal Methods (called by the mock) ----

  _getConnectError(): Error | null {
    return this._connectError;
  }

  _getListError(): Error | null {
    return this._listError;
  }

  _getStatusError(): Error | null {
    return this._statusError;
  }

  _setConnected(connected: boolean): void {
    this._connected = connected;
  }

  _addListener(listener: (event: WireEvent) => void): void {
    this._listeners.add(listener);
  }

  _removeListener(listener: (event: WireEvent) => void): void {
    this._listeners.delete(listener);
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

  _recordSwitch(call: {
    sessionId: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
  }): void {
    this._switchCalls.push(call);
  }

  _generateSessionId(): string {
    return `ses-${String(this._nextSessionId++).padStart(4, "0")}`;
  }

  // ---- MockState Implementation ----

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    const sessionCount = this._sessions.size;
    const sessionIds = Array.from(this._sessions.keys()).join(", ") || "(none)";
    const promptCount = this._prompts.length;
    const connected = this._connected ? "connected" : "disconnected";

    return `${sessionCount} session(s): ${sessionIds}, ${promptCount} prompt(s), ${connected}`;
  }
}

function mapError(error: Error): OpenCodeError {
  return new OpenCodeError(error.message, "REQUEST_FAILED");
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a behavioral mock wire client for testing.
 *
 * @example Basic usage
 * ```ts
 * const mock = createWireClientMock();
 * const client = new OpenCodeClient(8080, logger, { major: 1, directory: "/w" }, mockFactory(mock));
 * ```
 *
 * @example Emit events synchronously
 * ```ts
 * mock.$.emitEvent({ type: "session.status", sessionID: "ses-0001", status: "busy" });
 * // Listeners have been called before emitEvent returns.
 * ```
 */
export function createWireClientMock(options?: MockWireClientOptions): MockWireClient {
  // Build initial sessions map with defaults
  const sessionsMap = new Map<string, MockSession>();
  for (const sessionInput of options?.sessions ?? []) {
    const session: MockSession = {
      id: sessionInput.id,
      directory: sessionInput.directory,
      title: sessionInput.title ?? "Test Session",
      status: sessionInput.status ?? { type: "idle" },
      ...(sessionInput.parentID !== undefined && { parentID: sessionInput.parentID }),
      ...(sessionInput.time !== undefined && { time: sessionInput.time }),
    };
    sessionsMap.set(session.id, session);
  }

  const state = new WireClientMockStateImpl(sessionsMap);
  state.setConnectError(options?.connectError ?? null);
  state.setListError(options?.listError ?? null);
  state.setStatusError(options?.statusError ?? null);

  const mock: MockWireClient = {
    $: state,

    async listSessions(): Promise<Result<Session[], OpenCodeError>> {
      const error = state._getListError();
      if (error) return err(mapError(error));
      const sessions = Array.from(state.sessions.values()).map((s) => {
        const { status: _status, ...session } = s;
        return session;
      });
      return ok(sessions);
    },

    async createSession(): Promise<Result<Session, OpenCodeError>> {
      const session: MockSession = {
        id: state._generateSessionId(),
        directory: "",
        title: "New Session",
        status: { type: "idle" },
      };
      state._addSession(session);
      const { status: _status, ...sessionWithoutStatus } = session;
      return ok(sessionWithoutStatus);
    },

    async sendPrompt(
      sessionId: string,
      prompt: string,
      promptOptions?: WirePromptOptions
    ): Promise<Result<void, OpenCodeError>> {
      state._recordSwitch({
        sessionId,
        ...(promptOptions?.agent !== undefined && { agent: promptOptions.agent }),
        ...(promptOptions?.model !== undefined && { model: promptOptions.model }),
      });
      state._recordPrompt({
        sessionId,
        prompt,
        timestamp: Date.now(),
        ...(promptOptions?.agent !== undefined && { agent: promptOptions.agent }),
        ...(promptOptions?.model !== undefined && { model: promptOptions.model }),
      });
      return ok(undefined);
    },

    async sendPromptAsync(
      sessionId: string,
      prompt: string,
      promptOptions?: WirePromptOptions
    ): Promise<Result<void, OpenCodeError>> {
      state._recordPrompt({
        sessionId,
        prompt,
        timestamp: Date.now(),
        queued: true,
        ...(promptOptions?.agent !== undefined && { agent: promptOptions.agent }),
        ...(promptOptions?.model !== undefined && { model: promptOptions.model }),
      });
      return ok(undefined);
    },

    async getStatus(): Promise<Result<ClientStatus, OpenCodeError>> {
      const error = state._getStatusError();
      if (error) return err(mapError(error));
      const hasBusy = Array.from(state.sessions.values()).some(
        (s) => s.status.type === "busy" || s.status.type === "retry"
      );
      return ok(hasBusy ? "busy" : "idle");
    },

    async connect(_timeoutMs: number): Promise<void> {
      const connectError = state._getConnectError();
      if (connectError) throw connectError;
      state._setConnected(true);
    },

    onWireEvent(callback: (event: WireEvent) => void): () => void {
      state._addListener(callback);
      return () => state._removeListener(callback);
    },

    disconnect(): void {
      state._setConnected(false);
    },

    dispose(): void {
      this.disconnect();
    },
  };

  return mock;
}

/**
 * A WireClientFactory that hands out the provided mock.
 *
 * @example
 * ```ts
 * const mock = createWireClientMock({ sessions: [...] });
 * const client = new OpenCodeClient(8080, logger, opts, wireFactoryMock(mock));
 * ```
 */
export function wireFactoryMock(mock: MockWireClient): WireClientFactory {
  return () => mock;
}

// =============================================================================
// Custom Matchers
// =============================================================================

/** Custom matchers for MockWireClient assertions. */
interface WireClientMatchers {
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
  toHaveWireSession(sessionId: string): void;

  /**
   * Assert that the mock is connected (event stream active).
   */
  toBeConnected(): void;
}

// Module augmentation for vitest
declare module "vitest" {
  interface Matchers<R extends void | Promise<void>, T> extends WireClientMatchers {}
}

/** Matcher implementations. */
export const wireClientMatchers: MatcherImplementationsFor<MockWireClient, WireClientMatchers> = {
  toHaveSentPrompt(received, sessionId, text?) {
    const prompts = received.$.prompts.filter((p) => p.sessionId === sessionId);

    let pass: boolean;
    let matchDetails: string;

    if (text === undefined) {
      pass = prompts.length > 0;
      matchDetails = `any prompt to session ${sessionId}`;
    } else if (typeof text === "string") {
      pass = prompts.some((p) => p.prompt === text);
      matchDetails = `prompt "${text}" to session ${sessionId}`;
    } else {
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

  toHaveWireSession(received, sessionId) {
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
expect.extend(wireClientMatchers);

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Helper to create a test session object for the mock's initial state.
 */
export function createTestSession(
  overrides: Partial<MockSession> & { id: string; directory: string }
): MockSession {
  return {
    id: overrides.id,
    directory: overrides.directory,
    title: overrides.title ?? "Test Session",
    status: overrides.status ?? { type: "idle" },
    ...(overrides.parentID !== undefined && { parentID: overrides.parentID }),
    ...(overrides.time !== undefined && { time: overrides.time }),
  };
}
