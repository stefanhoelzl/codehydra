// @vitest-environment node
/**
 * Boundary tests for `ch mcp`'s connection, in the compiled `ch` bundle
 * (dist/bin/ch.cjs), which `pnpm build:wrappers` builds before tests run.
 *
 * What the app offers a connection — MCP's tools or the CLI's commands, with
 * whose defaults — follows the client kind its handshake declares, and who the
 * caller is follows the workspace it presents. `ch mcp` once declared itself
 * the CLI, and the CLI's shaping then dropped every tool's `workspace` argument
 * so the call acted on the calling agent's own workspace instead. The server's
 * side of the contract is covered with hand-built handshakes
 * (api-server-cli.boundary.test.ts); this pins the side the shim sends.
 *
 * The compiled bundle rather than `connect()` in-process: it is what agents
 * launch.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { assertCompiledScript } from "../modules/agent-module/wrapper-boundary-test-utils";

const COMPILED_SCRIPT_PATH = resolve(__dirname, "../../dist/bin/ch.cjs");
const TOKEN = "test-token";
const WORKSPACE = "ch::local::git::/repo::feature";

let http: HttpServer | undefined;
let io: Server | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  child?.kill();
  child = undefined;
  await io?.close();
  io = undefined;
  http = undefined;
});

/** A server that records the handshake of each client it admits. */
async function recordingServer(): Promise<{ port: number; auths: unknown[] }> {
  const auths: unknown[] = [];
  http = createServer();
  io = new Server(http, { transports: ["websocket"] });
  io.on("connection", (socket) => auths.push(socket.handshake.auth));
  await new Promise<void>((done) => http!.listen(0, "127.0.0.1", done));
  return { port: (http.address() as AddressInfo).port, auths };
}

/**
 * Start `ch mcp` against the server, with only the environment an agent config
 * gives it. It keeps running on an open stdin, as it does under an agent.
 */
function startMcp(port: number, env: Record<string, string>, cwd: string): void {
  child = spawn(process.execPath, [COMPILED_SCRIPT_PATH, "mcp"], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      _CH_API_PORT: String(port),
      _CH_API_TOKEN: TOKEN,
      ...env,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
}

async function firstHandshake(auths: unknown[]): Promise<unknown> {
  await expect.poll(() => auths.length, { timeout: 10_000 }).toBeGreaterThan(0);
  return auths[0];
}

describe("ch mcp", () => {
  beforeAll(async () => {
    await assertCompiledScript(COMPILED_SCRIPT_PATH);
  });

  it("connects as the MCP shim, from its agent's own workspace", async () => {
    const server = await recordingServer();

    startMcp(server.port, { _CH_WORKSPACE: WORKSPACE }, process.cwd());

    expect(await firstHandshake(server.auths)).toEqual({
      client: "mcp",
      token: TOKEN,
      cwd: process.cwd(),
      workspace: WORKSPACE,
    });
  });

  it("names no workspace when its agent runs outside one", async () => {
    const server = await recordingServer();

    startMcp(server.port, {}, process.cwd());

    expect(await firstHandshake(server.auths)).toEqual({
      client: "mcp",
      token: TOKEN,
      cwd: process.cwd(),
    });
  });
});
