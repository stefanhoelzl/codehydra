/**
 * StateService integration tests.
 *
 * Covers the async single-file lifecycle:
 * - missing state.json → defaults stand
 * - present values are loaded and readable
 * - set() persists to state.json (preserving other entries)
 * - corrupt / non-object / unknown entries are lenient (no throw)
 */

import { describe, it, expect } from "vitest";
import { Path } from "../../utils/path/path";
import { SILENT_LOGGER } from "./logging";
import { createFileSystemMock, file, directory } from "./filesystem.state-mock";
import { DefaultStateService } from "./state-service";
import type { StateServiceDeps } from "./state-service";
import { storeString } from "./store-definition";

const STATE_PATH = new Path("/app/state.json");

function createService(
  entries: Record<string, ReturnType<typeof file> | ReturnType<typeof directory>>
): { svc: DefaultStateService; fs: ReturnType<typeof createFileSystemMock> } {
  const fs = createFileSystemMock({ entries });
  const deps: StateServiceDeps = {
    statePath: STATE_PATH,
    fileSystem: fs,
    logger: SILENT_LOGGER,
  };
  return { svc: new DefaultStateService(deps), fs };
}

function stringKeyDef() {
  return { default: null as string | null, ...storeString({ nullable: true }) };
}

describe("StateService", () => {
  it("uses defaults when state.json is missing", async () => {
    const { svc } = createService({ "/app": directory() });
    const key = svc.register("telemetry.distinct-id", stringKeyDef());
    await svc.load();

    expect(key.get()).toBeNull();
    expect(svc.getEffective()).toEqual({ "telemetry.distinct-id": null });
  });

  it("loads a value present in state.json", async () => {
    const { svc } = createService({
      "/app": directory(),
      "/app/state.json": file(JSON.stringify({ "telemetry.distinct-id": "uuid-123" })),
    });
    const key = svc.register("telemetry.distinct-id", stringKeyDef());
    await svc.load();

    expect(key.get()).toBe("uuid-123");
  });

  it("persists to state.json on set(), preserving other entries", async () => {
    const { svc, fs } = createService({
      "/app": directory(),
      "/app/state.json": file(JSON.stringify({ "update.dismissed-version": "1.0.0" })),
    });
    const distinctId = svc.register("telemetry.distinct-id", stringKeyDef());
    svc.register("update.dismissed-version", stringKeyDef());
    await svc.load();

    await distinctId.set("uuid-xyz");

    const content = await fs.readFile(STATE_PATH);
    expect(JSON.parse(content)).toEqual({
      "update.dismissed-version": "1.0.0",
      "telemetry.distinct-id": "uuid-xyz",
    });
  });

  it("falls back to defaults on corrupt JSON (no throw)", async () => {
    const { svc } = createService({
      "/app": directory(),
      "/app/state.json": file("{ not valid json"),
    });
    const key = svc.register("telemetry.distinct-id", stringKeyDef());
    await expect(svc.load()).resolves.toBeUndefined();
    expect(key.get()).toBeNull();
  });

  it("ignores unknown entries in state.json (no throw)", async () => {
    const { svc } = createService({
      "/app": directory(),
      "/app/state.json": file(
        JSON.stringify({ "telemetry.distinct-id": "uuid-9", "no.longer.registered": "stale" })
      ),
    });
    const key = svc.register("telemetry.distinct-id", stringKeyDef());
    await svc.load();

    expect(key.get()).toBe("uuid-9");
  });

  it("ignores a non-object state.json (no throw)", async () => {
    const { svc } = createService({
      "/app": directory(),
      "/app/state.json": file(JSON.stringify(42)),
    });
    const key = svc.register("telemetry.distinct-id", stringKeyDef());
    await svc.load();

    expect(key.get()).toBeNull();
  });

  it("serializes concurrent writes so no update is lost", async () => {
    const { svc, fs } = createService({ "/app": directory() });
    const distinctId = svc.register("telemetry.distinct-id", stringKeyDef());
    const dismissed = svc.register("update.dismissed-version", stringKeyDef());
    await svc.load();

    // Two owners write the shared file at once. Without PersistedStore
    // serializing its read-modify-write, the two cycles interleave and one
    // key's write clobbers the other.
    await Promise.all([distinctId.set("uuid-xyz"), dismissed.set("2.0.0")]);

    const content = await fs.readFile(STATE_PATH);
    expect(JSON.parse(content)).toEqual({
      "telemetry.distinct-id": "uuid-xyz",
      "update.dismissed-version": "2.0.0",
    });
  });

  it("redacts overrides per key, applying true and custom redactors", async () => {
    const { svc } = createService({
      "/app": directory(),
      "/app/state.json": file(
        JSON.stringify({
          "telemetry.distinct-id": "uuid-secret",
          "tracked.item": "keep/this/path",
        })
      ),
    });
    svc.register("telemetry.distinct-id", { ...stringKeyDef(), redact: true });
    svc.register("tracked.item", {
      ...stringKeyDef(),
      redact: (value, redacted) => ({ value, token: redacted }),
    });
    await svc.load();

    // distinct-id fully redacted; the custom redactor sees the value + token;
    // getEffective stays raw (it never leaves the machine).
    expect(svc.getRedactedOverrides()).toEqual({
      "telemetry.distinct-id": "<redacted>",
      "tracked.item": { value: "keep/this/path", token: "<redacted>" },
    });
    expect(svc.getEffective()).toMatchObject({ "telemetry.distinct-id": "uuid-secret" });
  });

  it("throws on double load()", async () => {
    const { svc } = createService({ "/app": directory() });
    svc.register("telemetry.distinct-id", stringKeyDef());
    await svc.load();

    await expect(svc.load()).rejects.toThrow("StateService.load() has already been called");
  });
});
