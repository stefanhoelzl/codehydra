// @vitest-environment node
/**
 * The item contract, built from the real registry: what an automation's script
 * may print, and how a mistake in it is named.
 */

import { describe, it, expect } from "vitest";
import { createMockDispatcher } from "../../intents/lib/dispatcher.test-utils";
import { SILENT_LOGGER } from "../../boundaries/platform/logging.test-utils";
import { createMockConfig } from "../../boundaries/platform/config.test-utils";
import { createLockModule } from "../lock-module";
import { createRegistry } from "../../api/entries";
import { createItemSchemas } from "./items";

function schemas() {
  const dispatcher = createMockDispatcher();
  return createItemSchemas(
    createRegistry(
      {
        dispatcher,
        appLayer: { openPath: async () => undefined },
        awaitDeletion: () => ({ outcome: new Promise(() => {}), release: () => {} }),
        locks: createLockModule({ dispatcher, logger: SILENT_LOGGER }).locks,
        config: createMockConfig(),
        wakeups: { set: async () => {}, show: async () => null },
        readUserGuide: async () => "",
        plugins: () => {
          throw new Error("this test reaches no plugins");
        },
      },
      SILENT_LOGGER
    )
  );
}

describe("parse", () => {
  it("reads a create item with the automation-only fields and their defaults", () => {
    const item = schemas().parse({
      action: "workspace.create",
      name: "pr-7",
      project: "org/repo",
      key: "https://example.com/7",
      metadata: { title: "PR #7", tags: { review: { color: "#4b6de8" } }, "source-id": "7" },
    });

    expect(item).toEqual({
      action: "workspace.create",
      input: {
        name: "pr-7",
        project: "org/repo",
        key: "https://example.com/7",
        metadata: { title: "PR #7", tags: { review: { color: "#4b6de8" } }, "source-id": "7" },
        event: false,
        stealFocus: false,
      },
    });
  });

  it("reads another action's item as that operation's input", () => {
    expect(schemas().parse({ action: "workspace.hibernate", workspace: "pr-3" })).toEqual({
      action: "workspace.hibernate",
      input: { workspace: "pr-3" },
    });
  });

  it.each([
    ["no action", { name: "x" }, /needs an action/],
    ["an action no automation may run", { action: "config.set" }, /not an action an automation/],
    [
      "an unknown field",
      { action: "workspace.hibernate", workspace: "x", event: true },
      /unknown field event/,
    ],
    [
      "a typo",
      { action: "workspace.create", name: "x", stealfocus: true },
      /unknown field stealfocus/,
    ],
    ["a wrong type", { action: "workspace.create", name: "x", stealFocus: "yes" }, /stealFocus:/],
    ["a missing field", { action: "workspace.create" }, /workspace\.create: name:/],
    [
      "an invalid tag name",
      { action: "workspace.create", name: "x", metadata: { tags: { "1st": {} } } },
      /not a valid tag name/,
    ],
    [
      "a key CodeHydra manages",
      { action: "workspace.create", name: "x", metadata: { hibernated: "true" } },
      /hibernated: managed by CodeHydra, read-only/,
    ],
    ["not an object", "workspace.create", /must be a JSON object/],
  ])("refuses %s, naming it", (_what, raw, message) => {
    expect(() => schemas().parse(raw)).toThrow(message);
  });
});

describe("jsonSchema", () => {
  it("is an array of one strict branch per action, told apart by action", () => {
    const schema = schemas().jsonSchema() as {
      type: string;
      items: {
        oneOf: { properties: { action: { const: string } }; additionalProperties: boolean }[];
      };
    };

    expect(schema.type).toBe("array");
    const create = schema.items.oneOf.find((b) => b.properties.action.const === "workspace.create");
    expect(create?.additionalProperties).toBe(false);
    expect(Object.keys(create!.properties)).toEqual(
      expect.arrayContaining(["name", "project", "event", "key", "metadata"])
    );
    expect(schema.items.oneOf.map((b) => b.properties.action.const)).toContain("notification.show");
  });
});
