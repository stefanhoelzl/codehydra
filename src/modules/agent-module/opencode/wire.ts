/**
 * The wire seam between OpenCodeClient and an OpenCode server.
 *
 * OpenCode 1.x and 2.x speak different server APIs (see docs/AGENT_PROVIDERS.md): 1.x is
 * the `@opencode-ai/sdk` endpoints, 2.x is the `/api/*` surface of
 * `@opencode/client` with mandatory Basic auth. A {@link WireClient} is one of
 * those, normalized — the client's session tracking and status aggregation see
 * the same calls and events whichever the server speaks. The client picks the
 * wire by the resolved binary's major version.
 */

import type { Logger } from "../../../boundaries/platform/logging";
import { OpenCodeError } from "../../../shared/errors/service-errors";
import type { ClientStatus, Result, Session, Unsubscribe, UserRequestKind } from "./types";

/** The status a session reports; "retry" is a session working through failures. */
export type WireSessionStatus = "idle" | "busy" | "retry";

/**
 * A server event, normalized across the two APIs — the one shape the client's
 * session tracking and status aggregation see.
 */
export type WireEvent =
  | {
      readonly type: "session.status";
      readonly sessionID: string;
      readonly status: WireSessionStatus;
    }
  | {
      readonly type: "session.created";
      readonly sessionID: string;
      readonly parentID?: string;
      /** A child session's title is its task description, where `[bg]` opts it out. */
      readonly title?: string;
    }
  | { readonly type: "session.deleted"; readonly sessionID: string }
  | {
      readonly type: "user-request.asked";
      readonly kind: UserRequestKind;
      readonly id: string;
      readonly sessionID: string;
    }
  | {
      readonly type: "user-request.resolved";
      readonly kind: UserRequestKind;
      readonly requestID: string;
      readonly sessionID: string;
    };

/** Agent and model selection for a prompt. */
export interface WirePromptOptions {
  readonly agent?: string;
  readonly model?: { readonly providerID: string; readonly modelID: string };
}

/** What a wire client needs besides the server's URL. */
export interface WireClientOptions {
  /** Which API the server speaks — the default factory picks the wire by it. */
  readonly major: 1 | 2;
  /** The server's password (2.x only; 1.x has no auth). */
  readonly password?: string;
  /** The workspace's directory: where sessions are created, and how listings scope. */
  readonly directory: string;
  /**
   * 2.x only: an MCP server that creating a session and sending a prompt
   * wait for. 2.x connects MCP servers asynchronously, and a session created
   * before one connected runs its first turn without that server's tools.
   */
  readonly mcpServer?: string;
}

/**
 * One OpenCode server API. `connect` subscribes to the event stream; after it
 * resolves, every server event flows to the {@link WireClient.onWireEvent}
 * callbacks until `disconnect` or `dispose`.
 */
export interface WireClient {
  /** Every session the server knows of. */
  listSessions(): Promise<Result<Session[], OpenCodeError>>;
  /** Create a session in the workspace directory. */
  createSession(): Promise<Result<Session, OpenCodeError>>;
  /**
   * Send a prompt; resolves when the turn it starts has finished (2.x does this
   * with the `wait` endpoint on top of the prompt).
   */
  sendPrompt(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>>;
  /** Queue a prompt; resolves as soon as the server has accepted it. */
  sendPromptAsync(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>>;
  /** Whether any session is busy: any busy or retrying session reports "busy". */
  getStatus(): Promise<Result<ClientStatus, OpenCodeError>>;
  /** Subscribe to the event stream; resolves once connected. */
  connect(timeoutMs: number): Promise<void>;
  /** Observe normalized server events. */
  onWireEvent(callback: (event: WireEvent) => void): Unsubscribe;
  /** Stop the event stream; what already arrived is kept. */
  disconnect(): void;
  /** Final teardown. */
  dispose(): void;
}

/** Builds the wire client for a server's URL. The default builds by API major. */
export type WireClientFactory = (
  baseUrl: string,
  options: WireClientOptions,
  logger: Logger
) => WireClient;
