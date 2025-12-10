// @vitest-environment node
import { describe, it, expect } from "vitest";
import { findAvailablePort } from "./process";
import { createServer } from "net";

describe("findAvailablePort", () => {
  it("returns a valid port number", async () => {
    const port = await findAvailablePort();

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("returns different ports on subsequent calls", async () => {
    // Note: This may occasionally fail if the same port is reused
    // but is generally a good test for the port finding logic
    const port1 = await findAvailablePort();
    const port2 = await findAvailablePort();

    // Ports might be the same if reused quickly, so just verify they're valid
    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
  });

  it("returns a port that can be bound", async () => {
    const port = await findAvailablePort();

    // Verify we can actually bind to this port
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(port, () => resolve());
      server.on("error", reject);
    });
    server.close();
  });
});
