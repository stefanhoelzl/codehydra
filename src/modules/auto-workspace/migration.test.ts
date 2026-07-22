import { describe, it, expect } from "vitest";
import { SILENT_LOGGER } from "../../boundaries/platform/logging";
import { frontMatterToTemplate, buildSeededSources } from "./migration";
import { parseSources } from "./source-config";

describe("frontMatterToTemplate", () => {
  it("splits front-matter into an object and the body into prompt", () => {
    const tpl = frontMatterToTemplate(
      `---\nname: {{ title }}\nbase: {{ base.ref }}\n---\nReview {{ number }}`,
      SILENT_LOGGER
    );
    expect(tpl).toEqual({
      name: "{{ title }}",
      base: "{{ base.ref }}",
      prompt: "Review {{ number }}",
    });
  });

  it("nests dotted keys", () => {
    const tpl = frontMatterToTemplate(
      `---\nagent.type: claude\nagent.model.provider: anthropic\n---\nx`,
      SILENT_LOGGER
    );
    expect(tpl).toEqual({
      agent: { type: "claude", model: { provider: "anthropic" } },
      prompt: "x",
    });
  });

  it("drops deprecated bare agent/model keys", () => {
    const tpl = frontMatterToTemplate(
      `---\nname: n\nagent: claude\nmodel.provider: anthropic\n---\nx`,
      SILENT_LOGGER
    );
    expect(tpl).toEqual({ name: "n", prompt: "x" });
  });

  it("treats a template with no front-matter as prompt only", () => {
    expect(frontMatterToTemplate(`just a prompt`, SILENT_LOGGER)).toEqual({
      prompt: "just a prompt",
    });
  });
});

describe("buildSeededSources", () => {
  it("returns null when there is nothing to migrate", () => {
    expect(buildSeededSources({}, SILENT_LOGGER)).toBeNull();
  });

  it("seeds a github source with an injected html_url key and query in the cmd", () => {
    const yaml = buildSeededSources(
      { github: { template: `---\nname: {{ title }}\n---\nReview`, query: "is:open is:pr" } },
      SILENT_LOGGER
    );
    expect(yaml).not.toBeNull();
    const { sources, errors } = parseSources(yaml);
    expect(errors).toEqual([]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.name).toBe("github");
    expect(sources[0]!.template.key).toBe("{{ html_url }}");
    expect(sources[0]!.cmd).toContain("gh api graphql");
    expect(sources[0]!.cmd).toContain("is:open is:pr");
  });

  it("seeds a youtrack source preserving the old state key and inlining the token", () => {
    const yaml = buildSeededSources(
      {
        youtrack: {
          template: `---\nname: {{ summary }}\n---\nWork`,
          baseUrl: "https://yt.example.com",
          token: "perm:ABC",
          query: "for:me",
        },
      },
      SILENT_LOGGER
    );
    const { sources, errors } = parseSources(yaml);
    expect(errors).toEqual([]);
    expect(sources[0]!.name).toBe("youtrack");
    expect(sources[0]!.template.key).toBe("https://yt.example.com/api/issues/{{ id }}");
    expect(sources[0]!.cmd).toContain("Bearer perm:ABC");
    expect(sources[0]!.cmd).toContain("https://yt.example.com/api/issues");
  });

  it("does not overwrite an explicit key in the migrated template", () => {
    const yaml = buildSeededSources(
      { github: { template: `---\nname: {{ title }}\nkey: {{ number }}\n---\nx`, query: "q" } },
      SILENT_LOGGER
    );
    const { sources } = parseSources(yaml);
    expect(sources[0]!.template.key).toBe("{{ number }}");
  });

  it("emits both sources as a valid two-document stream", () => {
    const yaml = buildSeededSources(
      {
        github: { template: `---\nname: {{ title }}\n---\nx`, query: "q" },
        youtrack: {
          template: `---\nname: {{ summary }}\n---\ny`,
          baseUrl: "https://yt",
          token: "t",
          query: "q",
        },
      },
      SILENT_LOGGER
    );
    const { sources, errors } = parseSources(yaml);
    expect(errors).toEqual([]);
    expect(sources.map((s) => s.name)).toEqual(["github", "youtrack"]);
  });
});
