/**
 * The 2.x wire: OpenCode 2's server API (`/api/*`) through `@opencode/client`.
 *
 * Differences from 1.x that live here:
 * - Mandatory auth: the server was given a password, and every request
 *   authenticates with HTTP Basic, user `opencode`.
 * - Events: a turn no longer emits `session.status` — busy is the execution
 *   lifecycle (`session.execution.started`, `retry.scheduled`) and idle is its
 *   completion (`succeeded`/`failed`/`interrupted`). A `session.status` event
 *   is still mapped when one arrives, as the authoritative form.
 * - Prompts resolve on admission, not completion: {@link sendPrompt} waits for
 *   the session's agent loop to go idle (`session.wait`) to keep the client's
 *   turn-completion semantics.
 * - v1's `question` tool became forms (`form.created`/`replied`/`cancelled`).
 * - MCP servers connect asynchronously after the server starts, and a session
 *   that existed before one connected misses its tools for a moment after.
 *   Creating a session and sending a prompt both wait for CodeHydra's to
 *   settle, so the first turn already has its tools.
 */

import {
  OpenCode as OpenCodeClientFactory,
  type McpServer,
  type SessionInfo,
  type V2Event,
} from "@opencode/client";
import { OpenCodeError } from "../../../shared/errors/service-errors";
import { errorCode } from "../../../shared/error-utils";
import { withTimeout } from "../../../utils/timeout";
import type { Logger } from "../../../boundaries/platform/logging";
import { ok, err, type Result, type Session, type ClientStatus } from "./types";
import type { WireClient, WireClientOptions, WireEvent, WirePromptOptions } from "./wire";

/**
 * Normalize one 2.x server event. Returns undefined for anything the client
 * has nothing to do with; never throws.
 */
export function normalizeV2Event(event: V2Event): WireEvent | undefined {
  switch (event.type) {
    // The authoritative status event — mapped for the day the server emits
    // it; today a turn signals through the execution events below.
    case "session.status":
      return {
        type: "session.status",
        sessionID: event.data.sessionID,
        status: event.data.status.type,
      };

    case "session.execution.started":
      return { type: "session.status", sessionID: event.data.sessionID, status: "busy" };
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { type: "session.status", sessionID: event.data.sessionID, status: "idle" };
    case "session.retry.scheduled":
      // A retrying session is still working.
      return { type: "session.status", sessionID: event.data.sessionID, status: "busy" };

    case "session.created": {
      const { sessionID, parentID, title } = event.data;
      return {
        type: "session.created",
        sessionID,
        ...(parentID !== undefined && { parentID }),
        ...(title !== undefined && { title }),
      };
    }
    case "session.deleted":
      return { type: "session.deleted", sessionID: event.data.sessionID };

    case "permission.asked":
      return {
        type: "user-request.asked",
        kind: "permission",
        id: event.data.id,
        sessionID: event.data.sessionID,
      };
    case "permission.replied":
      return {
        type: "user-request.resolved",
        kind: "permission",
        requestID: event.data.requestID,
        sessionID: event.data.sessionID,
      };

    case "form.created":
      return {
        type: "user-request.asked",
        kind: "form",
        id: event.data.form.id,
        sessionID: event.data.form.sessionID,
      };
    case "form.replied":
    case "form.cancelled":
      return {
        type: "user-request.resolved",
        kind: "form",
        requestID: event.data.id,
        sessionID: event.data.sessionID,
      };

    default:
      return undefined;
  }
}

/** How long a prompt waits for its MCP server to leave `pending`; it then goes without. */
const MCP_READY_TIMEOUT_MS = 15_000;
const MCP_READY_POLL_MS = 250;
/** How long a server that just connected gets for its tools to reach new turns. */
const MCP_TOOLS_SETTLE_MS = 500;

/**
 * Wait until an MCP server has left `pending` — connected, or failed, either
 * way settled. 2.x connects MCP servers asynchronously after it starts, and a
 * turn begun before then has none of that server's tools (they arrive
 * mid-conversation as a system update). Capped: a server that never settles
 * must not hold the prompt back for good.
 *
 * `connected` is not yet "turns have its tools": the tool registry reloads
 * on a 100 ms debounce after it (2.2.1, `packages/core/src/tool/mcp.ts`),
 * and nothing announces the reload. A server seen unsettled therefore gets
 * {@link MCP_TOOLS_SETTLE_MS} more; one settled at the first look connected
 * long enough ago.
 */
export async function awaitMcpServer(
  listServers: () => Promise<{ readonly data: readonly McpServer[] }>,
  name: string,
  logger: Logger
): Promise<void> {
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS;
  let sawUnsettled = false;
  while (Date.now() < deadline) {
    try {
      const servers = await listServers();
      const server = servers.data.find((entry) => entry.name === name);
      // Absent: not loaded yet, which is as unsettled as pending.
      if (server !== undefined && server.status.status !== "pending") {
        logger.debug("MCP server settled", {
          server: name,
          status: server.status.status,
          ...("error" in server.status && { error: server.status.error }),
        });
        if (sawUnsettled && server.status.status === "connected") {
          await new Promise((resolve) => setTimeout(resolve, MCP_TOOLS_SETTLE_MS));
        }
        return;
      }
    } catch {
      // Not answering yet; the prompt itself reports a server that never does.
    }
    sawUnsettled = true;
    await new Promise((resolve) => setTimeout(resolve, MCP_READY_POLL_MS));
  }
  logger.warn("MCP server still pending; prompting without its tools", { server: name });
}

/** The 2.x server API, normalized to the {@link WireClient} seam. */
export class OpenCodeWireV2 implements WireClient {
  private readonly client: ReturnType<typeof OpenCodeClientFactory.make>;
  private readonly logger: Logger;
  private readonly directory: string;
  private readonly mcpServer: string | undefined;
  private readonly listeners = new Set<(event: WireEvent) => void>();
  /** Ends the event stream; null while disconnected. */
  private streamAbort: AbortController | null = null;
  private disposed = false;

  constructor(baseUrl: string, options: WireClientOptions, logger: Logger) {
    this.client = OpenCodeClientFactory.make({
      baseUrl,
      ...(options.password !== undefined && {
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`,
        },
      }),
    });
    this.directory = options.directory;
    this.mcpServer = options.mcpServer;
    this.logger = logger;
  }

  async listSessions(): Promise<Result<Session[], OpenCodeError>> {
    this.logger.debug("Listing sessions");
    try {
      const response = await this.client.session.list({
        // Root sessions in this workspace's directory, newest first; the
        // caller's own filters apply on top.
        directory: this.directory,
        parentID: "null",
        order: "desc",
        limit: 50,
      });
      return ok(response.data.map((s) => this.mapSession(s)));
    } catch (error) {
      return err(this.mapError(error));
    }
  }

  async createSession(): Promise<Result<Session, OpenCodeError>> {
    try {
      // A session created before the MCP server connects starts its first
      // turn without that server's tools even when the prompt waits for
      // `connected` (measured on 2.1.4: none at 0 ms after it, all from
      // ~100 ms); one created once its tools reached the registry has them at
      // once. So create after.
      await this.awaitMcpServer();
      const info = await this.client.session.create({ location: { directory: this.directory } });
      const session = this.mapSession(info);
      this.logger.debug("Session created", { sessionId: session.id });
      return ok(session);
    } catch (error) {
      return err(this.mapError(error));
    }
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>> {
    try {
      await this.preparePrompt(sessionId, options);
      await this.client.session.prompt({ sessionID: sessionId, text: prompt });
      // The prompt resolves on admission; wait for the loop it started to go
      // idle so the caller still sees the turn's completion.
      await this.client.session.wait({ sessionID: sessionId });
      return ok(undefined);
    } catch (error) {
      return err(this.mapError(error));
    }
  }

  async sendPromptAsync(
    sessionId: string,
    prompt: string,
    options?: WirePromptOptions
  ): Promise<Result<void, OpenCodeError>> {
    try {
      await this.preparePrompt(sessionId, options);
      await this.client.session.prompt({ sessionID: sessionId, text: prompt, delivery: "queue" });
      return ok(undefined);
    } catch (error) {
      return err(this.mapError(error));
    }
  }

  /** What every prompt needs before it is sent: the MCP server, then agent and model. */
  private async preparePrompt(sessionId: string, options?: WirePromptOptions): Promise<void> {
    await this.awaitMcpServer();
    // The 2.x prompt selects agent and model on the session rather than per
    // message (its `agents` field mentions subagents), so switch first when
    // they were given. Unlike 1.x the choice then stays for later turns.
    if (options?.model !== undefined) {
      await this.client.session.switchModel({
        sessionID: sessionId,
        model: { providerID: options.model.providerID, id: options.model.modelID },
      });
    }
    if (options?.agent !== undefined) {
      await this.client.session.switchAgent({ sessionID: sessionId, agent: options.agent });
    }
  }

  async getStatus(): Promise<Result<ClientStatus, OpenCodeError>> {
    try {
      // The sessions the server is currently running; the rest are idle.
      const active = await this.client.session.active();
      return ok(Object.keys(active).length > 0 ? "busy" : "idle");
    } catch (error) {
      return err(this.mapError(error));
    }
  }

  async connect(timeoutMs: number): Promise<void> {
    if (this.disposed || this.streamAbort !== null) return;

    this.logger.debug("Connecting");
    // One lazy shared stream; live-only, no replay, no auto-reconnect. The
    // signal ends it — the loop's pending next() completes when it aborts.
    const abort = new AbortController();
    const iterator = this.client.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]();

    // The server greets a fresh subscriber with a `server.connected` marker,
    // so the first event is what "connected" means.
    let first: IteratorResult<V2Event>;
    try {
      first = await withTimeout(iterator.next(), timeoutMs, () => new Error("Connect timeout"));
    } catch (error) {
      await iterator.return?.().catch(() => {});
      throw error;
    }
    if (first.done !== true) {
      this.dispatch(first.value);
    }
    this.streamAbort = abort;

    this.processEvents(iterator).catch((processError) => {
      // A disconnect aborts the stream on purpose; anything else, while still
      // connected, is worth a warning.
      if (!this.disposed && this.streamAbort !== null) {
        this.logger.warn("Connection error", { error: String(processError) });
      }
    });
  }

  onWireEvent(callback: (event: WireEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  disconnect(): void {
    if (this.streamAbort === null) return;
    this.streamAbort.abort();
    this.streamAbort = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.listeners.clear();
  }

  private async processEvents(iterator: AsyncIterator<V2Event>): Promise<void> {
    try {
      while (!this.disposed && this.streamAbort !== null) {
        const next = await iterator.next();
        if (next.done === true) break;
        this.dispatch(next.value);
      }
    } finally {
      // Release the transport whether the loop ended by disconnect, stream
      // end or error.
      await iterator.return?.();
    }
  }

  private async awaitMcpServer(): Promise<void> {
    if (this.mcpServer === undefined) return;
    await awaitMcpServer(
      () => this.client.mcp.list({ location: { directory: this.directory } }),
      this.mcpServer,
      this.logger
    );
  }

  /** Normalize one server event and hand it to the listeners. */
  private dispatch(event: V2Event): void {
    const normalized = normalizeV2Event(event);
    if (normalized !== undefined) {
      for (const listener of this.listeners) {
        listener(normalized);
      }
    }
  }

  private mapSession(info: SessionInfo): Session {
    return {
      id: info.id,
      directory: info.location.directory,
      ...(info.title !== undefined && { title: info.title }),
      ...(info.parentID !== undefined && { parentID: info.parentID }),
      time: { created: String(info.time.created), updated: info.time.updated },
    };
  }

  /** Same classification as the 1.x wire: structured fields, never the message. */
  private mapError(error: unknown): OpenCodeError {
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
