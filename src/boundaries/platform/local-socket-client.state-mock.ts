/**
 * Behavioral state mock for LocalSocketClient.
 *
 * Records every write instead of connecting, following the `MockWithState<T>`
 * pattern from `src/test/state-mock.ts`. A configured failure makes `send()`
 * reject the way a missing socket or a reset connection would.
 */

import type { LocalSocketClient, LocalSocketSendOptions } from "./network";
import type { MockState, MockWithState, Snapshot } from "../../test/state-mock";
import { createSnapshot } from "../../test/state-mock";

/** One write handed to the mock. */
export interface LocalSocketSendRecord {
  readonly socketPath: string;
  readonly data: string;
  readonly options: LocalSocketSendOptions | undefined;
}

/**
 * State for the LocalSocketClient mock: the writes so far, and the error the
 * next writes fail with (null = they succeed).
 */
export class LocalSocketClientMockState implements MockState {
  private readonly _sent: LocalSocketSendRecord[] = [];
  private _failure: Error | null = null;

  /** Writes that succeeded, in order. */
  get sent(): readonly LocalSocketSendRecord[] {
    return this._sent;
  }

  /** The error writes currently fail with, or null. */
  get failure(): Error | null {
    return this._failure;
  }

  /** Make every following write fail with `error`; null makes them succeed again. */
  failWith(error: Error | null): void {
    this._failure = error;
  }

  /** Record a write, or throw the configured failure. */
  record(entry: LocalSocketSendRecord): void {
    if (this._failure !== null) throw this._failure;
    this._sent.push(entry);
  }

  snapshot(): Snapshot {
    return createSnapshot(this);
  }

  toString(): string {
    const writes = this._sent.map((entry) => `${entry.socketPath}: ${JSON.stringify(entry.data)}`);
    return `LocalSocketClientMockState { sent: [${writes.join(", ")}], failure: ${this._failure?.message ?? "none"} }`;
  }
}

/** Mock LocalSocketClient with inspectable state. */
export type MockLocalSocketClient = LocalSocketClient & MockWithState<LocalSocketClientMockState>;

/**
 * Create a mock LocalSocketClient.
 *
 * @example
 * ```ts
 * const sockets = createLocalSocketClientMock();
 * await sockets.send("/run/inbox.sock", "hello\n");
 * expect(sockets.$.sent).toEqual([{ socketPath: "/run/inbox.sock", data: "hello\n", options: undefined }]);
 *
 * sockets.$.failWith(new Error("connect ENOENT"));
 * await expect(sockets.send("/run/inbox.sock", "x")).rejects.toThrow("ENOENT");
 * ```
 */
export function createLocalSocketClientMock(): MockLocalSocketClient {
  const state = new LocalSocketClientMockState();
  return {
    $: state,
    async send(socketPath: string, data: string, options?: LocalSocketSendOptions): Promise<void> {
      state.record({ socketPath, data, options });
    },
  };
}
