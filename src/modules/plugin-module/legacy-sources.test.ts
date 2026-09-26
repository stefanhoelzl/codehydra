import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { convertLegacySources, parseSources } from "./legacy-sources";
import { parseManifest } from "./manifest";

const GH = `name: github
type: cron
cmd: gh api graphql --jq '.'
template:
  name: "{{ title }}"
  key: "{{ html_url }}"
  prompt: "Review {{ number }}"`;

const YT = `name: youtrack
cmd: curl -s https://yt/api/issues
template:
  name: "{{ summary }}"`;

describe("parseSources", () => {
  it("returns nothing for null / empty input", () => {
    expect(parseSources(null)).toEqual({ sources: [], errors: [] });
    expect(parseSources("   ")).toEqual({ sources: [], errors: [] });
  });

  it("parses multiple documents into sources", () => {
    const { sources, errors } = parseSources(`${GH}\n---\n${YT}`);
    expect(errors).toEqual([]);
    expect(sources.map((s) => s.name)).toEqual(["github", "youtrack"]);
    expect(sources[0]!.type).toBe("cron");
    expect(sources[0]!.template.name).toBe("{{ title }}");
  });

  it("defaults type to cron when omitted", () => {
    const { sources } = parseSources(YT);
    expect(sources[0]!.type).toBe("cron");
  });

  it("defaults mode to workspaces when omitted", () => {
    const { sources } = parseSources(YT);
    expect(sources[0]!.mode).toBe("workspaces");
  });

  it("parses mode: events", () => {
    const { sources, errors } = parseSources(
      `name: a\ntype: cron\nmode: events\ncmd: x\ntemplate:\n  name: y`
    );
    expect(errors).toEqual([]);
    expect(sources[0]!.mode).toBe("events");
    expect(sources[0]!.type).toBe("cron"); // mode is a separate axis from the trigger
  });

  it("errors on an unsupported mode", () => {
    const { sources, errors } = parseSources(
      `name: a\nmode: webhook\ncmd: x\ntemplate:\n  name: y`
    );
    expect(sources).toHaveLength(0);
    expect(errors[0]).toMatchObject({ name: "a", message: expect.stringContaining("webhook") });
  });

  it("ignores an empty trailing document", () => {
    const { sources, errors } = parseSources(`${GH}\n---\n`);
    expect(errors).toEqual([]);
    expect(sources).toHaveLength(1);
  });

  it("errors on a missing name (by index)", () => {
    const { sources, errors } = parseSources(`cmd: x\ntemplate:\n  name: y`);
    expect(sources).toHaveLength(0);
    expect(errors[0]).toMatchObject({ index: 1, message: expect.stringContaining("name") });
  });

  it("errors on a missing cmd", () => {
    const { errors } = parseSources(`name: a\ntemplate:\n  name: y`);
    expect(errors[0]).toMatchObject({ name: "a", message: expect.stringContaining("cmd") });
  });

  it("errors on a missing template.name", () => {
    const { errors } = parseSources(`name: a\ncmd: x\ntemplate:\n  prompt: hi`);
    expect(errors[0]).toMatchObject({
      name: "a",
      message: expect.stringContaining("template.name"),
    });
  });

  it("rejects type: event as unsupported", () => {
    const { errors } = parseSources(`name: a\ntype: event\ncmd: x\ntemplate:\n  name: y`);
    expect(errors[0]!.message).toContain("only 'cron'");
  });

  it("errors on duplicate names", () => {
    const { sources, errors } = parseSources(`${GH}\n---\n${GH}`);
    expect(sources).toHaveLength(1);
    expect(errors[0]!.message).toContain("Duplicate");
  });

  it("errors on invalid Liquid in a template leaf, naming the source", () => {
    const bad = `name: a\ncmd: x\ntemplate:\n  name: "{{ unclosed"`;
    const { sources, errors } = parseSources(bad);
    expect(sources).toHaveLength(0);
    expect(errors[0]).toMatchObject({ name: "a", message: expect.stringContaining("Liquid") });
  });

  it("keeps valid documents when another is malformed", () => {
    const { sources, errors } = parseSources(
      `${GH}\n---\nname: b\ntype: event\ncmd: x\ntemplate:\n  name: y`
    );
    expect(sources.map((s) => s.name)).toEqual(["github"]);
    expect(errors).toHaveLength(1);
  });
});

describe("convertLegacySources", () => {
  it("pipes each source's cmd, grouped, through ch plugin render and its template", () => {
    const converted = convertLegacySources(
      `name: gh prs\nmode: events\ncmd: |\n  gh pr list \\\n    --json number\ntemplate:\n  name: "pr-{{ number }}"\n---\nname: jira\ncmd: ./jira\ntemplate:\n  name: "{{ key }}"`,
      "linux"
    );

    const [doc] = parseManifest(converted.manifest);
    expect(doc).toMatchObject({ shell: "bash", platforms: ["linux", "windows", "macos"] });
    expect(doc?.automations).toEqual([
      {
        name: "gh-prs",
        script:
          '{\ngh pr list \\\n  --json number\n} | ch plugin render "$CH_PLUGIN_DIR/templates/gh-prs.yaml"',
      },
      {
        name: "jira",
        script: '{\n./jira\n} | ch plugin render "$CH_PLUGIN_DIR/templates/jira.yaml"',
      },
    ]);
    expect([...converted.renames]).toEqual([
      ["gh prs", "gh-prs"],
      ["jira", "jira"],
    ]);
  });

  it("rewrites each template to the create-item shape, the mode as event", () => {
    const converted = convertLegacySources(
      [
        "name: gh",
        "mode: events",
        "cmd: x",
        "template:",
        '  name: "pr-{{ number }}"',
        '  key: "{{ url }}"',
        "  git: org/repo",
        "  focus: true",
        '  prompt: "Review {{ url }}"',
        "  agent: { type: claude, name: reviewer, permission-mode: plan, model: { provider: anthropic, id: opus } }",
        '  metadata: { title: "PR {{ number }}", tags: { review: { color: "#4b6de8" } }, ci: { run: "{{ run }}" } }',
        "  shiny: yes",
      ].join("\n"),
      "linux"
    );

    expect(parse(converted.templates["gh.yaml"]!)).toEqual({
      action: "workspace.create",
      event: true,
      name: "pr-{{ number }}",
      key: "{{ url }}",
      project: "org/repo",
      stealFocus: true,
      prompt: "Review {{ url }}",
      agent: "claude",
      agentName: "reviewer",
      permissionMode: "plan",
      model: "anthropic/opus",
      metadata: {
        title: "PR {{ number }}",
        tags: { review: { color: "#4b6de8" } },
        "ci.run": "{{ run }}",
      },
    });
    expect(converted.dropped).toEqual([{ source: "gh", field: "shiny" }]);
  });

  it("keeps a Windows command line in cmd, on Windows only", () => {
    const converted = convertLegacySources(`name: a\ncmd: dir\ntemplate:\n  name: x`, "win32");

    const manifest = parse(converted.manifest) as { automations: Record<string, string> };
    expect(manifest).toMatchObject({ shell: "cmd", platform: "windows" });
    expect(manifest.automations["a"]).toBe(
      '(\r\ndir\r\n) | ch plugin render "%CH_PLUGIN_DIR%\\templates\\a.yaml"'
    );
  });

  it("gives colliding names distinct automations", () => {
    const converted = convertLegacySources(
      `name: a b\ncmd: x\ntemplate:\n  name: x\n---\nname: a-b\ncmd: y\ntemplate:\n  name: y`,
      "linux"
    );

    expect([...converted.renames.values()]).toEqual(["a-b", "a-b-2"]);
  });
});
