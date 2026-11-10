/**
 * Focused tests for merging project types' option descriptions and checking
 * option values against them (pure: input → output).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import {
  ProjectTypeOptions,
  sealedProjectTypeOptions,
  type ProjectTypeDescription,
} from "./project-type-options";
import { ApiError } from "../api/errors";
import { GIT_PROJECT_OPTIONS } from "../modules/git/options";
import { FAKE_PROJECT_OPTIONS, fakeProjectRef } from "../modules/fake-project-type.test-utils";
import { gitProjectRef } from "../modules/git/ref";

const GIT_REF = gitProjectRef("/projects/repo");
const FAKE_REF = fakeProjectRef("/projects/folders");

/** A stand-in type declaring a create option of its own. */
function typeWith(
  type: string,
  create: NonNullable<ProjectTypeDescription["create"]>
): ProjectTypeDescription {
  return { type, create };
}

describe("ProjectTypeOptions: merging", () => {
  it("merges every type's options by name", () => {
    const options = sealedProjectTypeOptions(GIT_PROJECT_OPTIONS, FAKE_PROJECT_OPTIONS);

    expect(options.names("create")).toEqual(["base", "tracking", "template"]);
    expect(options.names("delete")).toEqual(["keepBranch", "archive"]);
  });

  it("lets two types share a name declared the same way", () => {
    const same = { kind: "text", description: "Where to start." } as const;
    const options = sealedProjectTypeOptions(
      typeWith("one", { start: same }),
      typeWith("two", { start: same })
    );

    expect(options.names("create")).toEqual(["start"]);
  });

  it("fails when two types declare one name differently, naming both", () => {
    expect(() =>
      sealedProjectTypeOptions(
        GIT_PROJECT_OPTIONS,
        typeWith("other", { base: { kind: "text", description: "Not a branch." } })
      )
    ).toThrow(/"git" and "other" both declare the create option "base", differently/);
  });

  it("fails when an option is named like a core field of the operation", () => {
    const options = new ProjectTypeOptions();
    options.reserve("create", ["name", "prompt"]);

    expect(() => options.seal([typeWith("other", { prompt: { kind: "text" } })])).toThrow(
      /"other" declares the create option "prompt", which is a field of every workspace create/
    );
  });

  it("fails a reservation that a sealed holder's option already holds", () => {
    const options = sealedProjectTypeOptions(GIT_PROJECT_OPTIONS);

    expect(() => options.reserve("create", ["base"])).toThrow(
      /"git" declares the create option "base"/
    );
  });

  it("fails when more than one option is positional", () => {
    expect(() =>
      sealedProjectTypeOptions(
        GIT_PROJECT_OPTIONS,
        typeWith("other", { start: { kind: "text", positional: true } })
      )
    ).toThrow(/More than one positional create option/);
  });

  it("fails when a type answers twice", () => {
    expect(() => sealedProjectTypeOptions(GIT_PROJECT_OPTIONS, GIT_PROJECT_OPTIONS)).toThrow(
      /"git" described its options twice/
    );
  });

  it("rejects a description that is not one", () => {
    expect(() =>
      sealedProjectTypeOptions(typeWith("other", { start: { kind: "select" } }))
    ).toThrow();
    expect(() =>
      sealedProjectTypeOptions(typeWith("other", { "not-camel": { kind: "text" } }))
    ).toThrow();
    expect(() =>
      sealedProjectTypeOptions(typeWith("other", { flag: { kind: "checkbox", default: "yes" } }))
    ).toThrow();
  });

  it("throws when read before app:start sealed it", () => {
    expect(() => new ProjectTypeOptions().names("create")).toThrow(/before app:start/);
  });

  it("names the one positional option", () => {
    expect(sealedProjectTypeOptions(GIT_PROJECT_OPTIONS).positional("create")).toBe("base");
    expect(sealedProjectTypeOptions(FAKE_PROJECT_OPTIONS).positional("create")).toBeUndefined();
  });
});

describe("ProjectTypeOptions: input shape", () => {
  it("makes every option optional with no zod default, the default only annotated", () => {
    const shape = sealedProjectTypeOptions(GIT_PROJECT_OPTIONS).inputShape("delete");
    const schema = z.object(shape);

    expect(schema.parse({})).toEqual({});
    expect(z.toJSONSchema(schema, { io: "input" })).toMatchObject({
      properties: { keepBranch: { type: "boolean", default: false } },
    });
  });

  it("types a static select as its choices", () => {
    const schema = z.object(sealedProjectTypeOptions(FAKE_PROJECT_OPTIONS).inputShape("create"));

    expect(schema.safeParse({ template: "readme" }).success).toBe(true);
    expect(schema.safeParse({ template: "other" }).success).toBe(false);
  });
});

describe("ProjectTypeOptions: resolve", () => {
  const options = sealedProjectTypeOptions(GIT_PROJECT_OPTIONS, FAKE_PROJECT_OPTIONS);

  it("applies the project's type's defaults", () => {
    expect(options.resolve(GIT_REF, "delete", undefined)).toEqual({ keepBranch: false });
    expect(options.resolve(FAKE_REF, "delete", {})).toEqual({ archive: false });
    expect(options.resolve(FAKE_REF, "create", {})).toEqual({ template: "empty" });
  });

  it("keeps the values given", () => {
    expect(options.resolve(GIT_REF, "create", { base: "main", tracking: "origin/x" })).toEqual({
      base: "main",
      tracking: "origin/x",
    });
    expect(options.resolve(GIT_REF, "delete", { keepBranch: true })).toEqual({ keepBranch: true });
  });

  it("refuses another type's option as the caller's mistake", () => {
    const refuse = () => options.resolve(FAKE_REF, "create", { base: "main" });

    expect(refuse).toThrow(ApiError);
    expect(refuse).toThrow(/"base" is not a create option of fake projects/);
    try {
      refuse();
    } catch (error) {
      expect((error as ApiError).category).toBe("usage");
    }
  });

  it("refuses a value its declaration rejects", () => {
    expect(() => options.resolve(GIT_REF, "delete", { keepBranch: "yes" })).toThrow(ApiError);
    expect(() => options.resolve(GIT_REF, "create", { base: "" })).toThrow(ApiError);
    expect(() => options.resolve(FAKE_REF, "create", { template: "other" })).toThrow(ApiError);
  });

  it("takes nothing for a type that declares nothing", () => {
    const none = sealedProjectTypeOptions();

    expect(none.resolve(GIT_REF, "create", {})).toEqual({});
    expect(() => none.resolve(GIT_REF, "create", { base: "main" })).toThrow(ApiError);
  });
});
