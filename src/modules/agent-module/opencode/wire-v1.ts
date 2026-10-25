/**
 * The 1.x wire: OpenCode 1's server API through `@opencode-ai/sdk`.
 *
 * The SDK still types the event stream as of 1.1.1, when permissions moved to
 * `permission.asked`/`permission.replied` with a `requestID` and the
 * `question` tool began parking a session — those event types only exist in
 * the SDK's v2 types, hence the `SdkEvent | SdkV2Event` union.
 */

import {
  createOpencodeClient,
  type OpencodeClient,
  type Session as SdkSession,
  type SessionStatus as SdkSessionStatus,
  type Event as SdkEvent,
} from "@opencode-ai/sdk";
import type { Event as SdkV2Event } from "@opencode-ai/sdk/v2";
import { OpenCodeError, getErrorMessage } from "../../../shared/errors/service-errors";
import { errorCode } from "../../../shared/error-utils";
import { withTimeout } from "../../../utils/timeout";
import type { Logger } from "../../../boundaries/platform/logging";
import { ok, err, type Result, type Session, type ClientStatus } from "./types";
import type { WireClient, WireClientOptions, WireEvent, WirePromptOptions } from "./wire";

/** An event from the 1.x server's `/event` stream. */
type ServerEvent = SdkEvent | SdkV2Event;

/**
 * Type guard for the `{ id, sessionID }` a `permission.asked` or
 * `question.asked` event carries.
 */
export function isUserRequestAsked(value: unknown): value is { id: string; sessionID: string } {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.sessionID === "string";
}

/**
 * Type guard for the `{ sessionID, requestID }` a `permission.replied`,
 * `question.replied` or `question.rejected` event carries.
 */
export function isUserRequestResolved(
  value: unknown
): value is { sessionID: string; requestID: string } {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  return typeof obj.sessionID === "string" && typeof obj.requestID === "string";
}

/**
 * Normalize one 1.x SDK event. Returns undefined for shapes the client has
 * nothing to do with — including malformed payloads and the pre-1.1
 * `permission.updated` event — never throws.
 */
export function normalizeSdkEvent(event: ServerEvent): WireEvent | undefined {
  switch (event.type) {
    case "session.status": {
      const { sessionID, status } = event.properties as {
        sessionID?: string;
        status?: { type?: string };
      };
      if (!sessionID || !status?.type) return undefined;
      if (status.type === "idle" || status.type === "busy" || status.type === "retry") {
        return { type: "session.status", sessionID, status: status.type };
      }
      return undefined;
    }
    case "session.created": {
      const info = (
        event.properties as { info?: { id?: string; parentID?: string; title?: string } }
      ).info;
      if (!info || typeof info.id !== "string") return undefined;
      return {
        type: "session.created",
        sessionID: info.id,
        ...(info.parentID !== undefined && { parentID: info.parentID }),
        ...(typeof info.title === "string" && { title: info.title }),
      };
    }
    case "session.idle": {
      const { sessionID } = event.properties as { sessionID?: string };
      if (!sessionID) return undefined;
      return { type: "session.status", sessionID, status: "idle" };
    }
    case "session.deleted": {
      const properties = event.properties as { info?: { id?: string }; sessionID?: string };
      const sessionID = properties.info?.id ?? properties.sessionID;
      if (!sessionID) return undefined;
      return { type: "session.deleted", sessionID };
    }
    case "permission.asked":
      return normalizeSdkAsked("permission", event.properties);
    case "permission.replied":
      return normalizeSdkResolved("permission", event.properties);
    case "question.asked":
      return normalizeSdkAsked("question", event.properties);
    case "question.replied":
    case "question.rejected":
      return normalizeSdkResolved("question", event.properties);
    default:
      // Unknown and pre-1.1 events (`permission.updated` and friends) have
      // nothing to say to the client.
      return undefined;
  }
}

function normalizeSdkAsked(
  kind: "permission" | "question",
  properties: unknown
): WireEvent | undefined {
  if (!isUserRequestAsked(properties)) return undefined;
  return { type: "user-request.asked", kind, id: properties.id, sessionID: properties.sessionID };
}

function normalizeSdkResolved(
  kind: "permission" | "question",
  properties: unknown
): WireEvent | undefined {
  if (!isUserRequestResolved(properties)) return undefined;
  return {
    type: "user-request.resolved",
    kind,
    requestID: properties.requestID,
    sessionID: properties.sessionID,
  };
}

/** The 1.x server API, normalized to the {@link WireClient} seam. */
export class OpenCodeWireV1 implements WireClient {
  private readonly sdk: OpencodeClient;
  private readonly logger: Logger;
  private readonly listeners = new Set<(event: WireEvent) => void>();
  /** The connected event stream; null while disconnected. */
  private eventStream: AsyncIterable<SdkEvent> | null = null;
  private disposed = false;

  constructor(baseUrl: string, _options: WireClientOptions, logger: Logger) {
    this.sdk = createOpencodeClient({ baseUrl });
    this.logger = logger;
  }

  async listSessions(): Promise<Result<Session[], OpenCodeError>> {
    this.logger.debug("Listing sessions");
    try {
      const result = await this.sdk.session.list();
      const sessions = result.data as SdkSession[];
      return ok(sessions.map((s) => this.mapSdkSession(s)));
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  async createSession(): Promise<Result<Session, OpenCodeError>> {
    try {
      const result = await this.sdk.session.create({ body: {} });
      if (!result.data) {
        return err(new OpenCodeError("Session creation returned no data", "REQUEST_FAILED"));
      }
      const session = this.mapSdkSession(result.data);
      this.logger.debug("Session created", { sessionId: session.id });
      return ok(session);
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>> {
    try {
      // Resolves when the turn it starts has finished.
      await this.sdk.session.prompt({
        path: { id: sessionId },
        body: {
          ...(options?.agent !== undefined && { agent: options.agent }),
          ...(options?.model !== undefined && { model: options.model }),
          parts: [{ type: "text", text: prompt }],
        },
      });
      return ok(undefined);
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  async sendPromptAsync(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>> {
    try {
      const result = await this.sdk.session.promptAsync({
        path: { id: sessionId },
        body: {
          ...(options?.agent !== undefined && { agent: options.agent }),
          ...(options?.model !== undefined && { model: options.model }),
          parts: [{ type: "text", text: prompt }],
        },
      });
      if (result.error !== undefined) {
        return err(
          new OpenCodeError(
            `Prompt was not accepted: ${JSON.stringify(result.error)}`,
            "REQUEST_FAILED"
          )
        );
      }
      return ok(undefined);
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  async getStatus(): Promise<Result<ClientStatus, OpenCodeError>> {
    try {
      const result = await this.sdk.session.status();
      const statuses = result.data as Record<string, SdkSessionStatus>;
      const hasBusy = Object.values(statuses).some((s) => s.type === "busy" || s.type === "retry");
      return ok(hasBusy ? "busy" : "idle");
    } catch (error) {
      return err(this.mapSdkError(error));
    }
  }

  async connect(timeoutMs: number): Promise<void> {
    if (this.disposed || this.eventStream !== null) return;

    const events = await withTimeout(
      this.sdk.event.subscribe(),
      timeoutMs,
      () => new Error("Connect timeout")
    );

    this.eventStream = events.stream;

    this.processEvents(events.stream).catch((processError) => {
      if (!this.disposed) {
        this.logger.warn("Connection error", { error: getErrorMessage(processError) });
      }
    });
  }

  onWireEvent(callback: (event: WireEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  disconnect(): void {
    this.eventStream = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.listeners.clear();
  }

  private async processEvents(stream: AsyncIterable<SdkEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.disposed || this.eventStream === null) break;
        this.handleSdkEvent(event);
      }
    } catch (error) {
      if (this.disposed) return; // Expected during shutdown
      throw error; // Re-throw for .catch() handler
    }
  }

  /** Normalize one SDK event and hand it to the listeners. */
  private handleSdkEvent(event: ServerEvent): void {
    const normalized = normalizeSdkEvent(event);
    if (normalized !== undefined) {
      for (const listener of this.listeners) {
        listener(normalized);
      }
    }
  }

  private mapSdkSession(sdkSession: SdkSession): Session {
    const session: Session = {
      id: sdkSession.id,
      directory: sdkSession.directory,
      title: sdkSession.title,
    };
    // Only add parentID if it exists (to satisfy exactOptionalPropertyTypes)
    if (sdkSession.parentID) {
      return { ...session, parentID: sdkSession.parentID };
    }
    return session;
  }

  /**
   * Map SDK errors to OpenCodeError.
   *
   * Classified by fetch's structured fields, never the message: a refused
   * connection rejects with `cause.code` "ECONNREFUSED", an AbortSignal timeout
   * with name "TimeoutError". The original message is kept either way.
   */
  private mapSdkError(error: unknown): OpenCodeError {
    if (error instanceof Error) {
      if (error.name === "TimeoutError") {
        return new OpenCodeError(error.message, "TIMEOUT");
      }
      if (errorCode(error.cause) === "ECONNREFUSED") {
        return new OpenCodeError(error.message, "CONNECTION_REFUSED");
      }
      return new OpenCodeError(error.message, "REQUEST_FAILED");
    }
    return new OpenCodeError("Unknown error", "REQUEST_FAILED");
  }
}
