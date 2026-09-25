/**
 * `ch mcp`'s reconnecting client: a connection that dropped (as it does across
 * a suspend) is replaced on the next call instead of hanging every call after
 * it — against fake clients, so what is asserted is when a call is retried.
 */

import { describe, it, expect } from "vitest";
import { reconnecting } from "./mcp";
import { NotConnectedError, UnreachableError, type Client } from "./client";

interface FakeClient extends Client {
  readonly calls: string[];
  closed: boolean;
}

function fakeClient(behavior: (channel: string) => unknown): FakeClient {
  const client: FakeClient = {
    calls: [],
    closed: false,
    async call<T>(channel: string): Promise<T> {
      client.calls.push(channel);
      const reply = behavior(channel);
      if (reply instanceof Error) throw reply;
      return reply as T;
    },
    onEvent: () => () => {},
    close() {
      client.closed = true;
    },
  };
  return client;
}

describe("reconnecting", () => {
  it("passes calls through while the connection is up", async () => {
    const first = fakeClient(() => "ok");
    let connects = 0;
    const client = reconnecting(first, async () => {
      connects++;
      return fakeClient(() => "fresh");
    });

    expect(await client.call("a")).toBe("ok");
    expect(connects).toBe(0);
  });

  it("reconnects and retries a call refused on a dropped connection", async () => {
    const dead = fakeClient(() => new NotConnectedError());
    const fresh = fakeClient(() => "ok");
    const client = reconnecting(dead, async () => fresh);

    expect(await client.call("api:operation:workspace.delete")).toBe("ok");
    expect(dead.closed).toBe(true);
    expect(fresh.calls).toEqual(["api:operation:workspace.delete"]);

    // The replacement is kept for later calls.
    expect(await client.call("b")).toBe("ok");
    expect(dead.calls).toHaveLength(1);
  });

  it("does not retry a call that was lost in flight", async () => {
    const dropped = fakeClient(() => new UnreachableError("CodeHydra closed the connection"));
    let connects = 0;
    const client = reconnecting(dropped, async () => {
      connects++;
      return fakeClient(() => "ok");
    });

    await expect(client.call("a")).rejects.toThrow("CodeHydra closed the connection");
    expect(connects).toBe(0);
  });

  it("opens one connection for concurrent calls that find it dropped", async () => {
    const dead = fakeClient(() => new NotConnectedError());
    let connects = 0;
    const client = reconnecting(dead, async () => {
      connects++;
      return fakeClient((channel) => channel);
    });

    expect(await Promise.all([client.call("a"), client.call("b")])).toEqual(["a", "b"]);
    expect(connects).toBe(1);
  });

  it("reports a failed reconnect and tries again on the next call", async () => {
    const dead = fakeClient(() => new NotConnectedError());
    let attempt = 0;
    const client = reconnecting(dead, async () => {
      attempt++;
      if (attempt === 1) throw new UnreachableError("Could not reach CodeHydra");
      return fakeClient(() => "ok");
    });

    await expect(client.call("a")).rejects.toThrow("Could not reach CodeHydra");
    expect(await client.call("a")).toBe("ok");
  });
});
