import { describe, it, expect } from "vitest";
import { parseTemplate, renderInput } from "./template-render";

describe("renderInput", () => {
  it("renders string leaves and keeps other values as written", () => {
    const input = renderInput(
      {
        workspace: "{{ ws }}",
        dismissible: true,
        lines: ["a {{ n }}", 2],
        nested: { title: "#{{ n }}", count: null },
      },
      { ws: "feature-x", n: 7 }
    );

    expect(input).toEqual({
      workspace: "feature-x",
      dismissible: true,
      lines: ["a 7", 2],
      nested: { title: "#7", count: null },
    });
  });

  it("renders a field the item does not have as empty, and leaves out a field left empty", () => {
    expect(renderInput({ name: "pr-{{ number }}", prompt: "{{ body }}" }, {})).toEqual({
      name: "pr-",
    });
  });
});

describe("parseTemplate", () => {
  it("reads a YAML mapping", () => {
    expect(parseTemplate('action: workspace.create\nname: "pr-{{ number }}"\n')).toEqual({
      action: "workspace.create",
      name: "pr-{{ number }}",
    });
  });

  it.each([
    ["not a mapping", "- a\n- b\n", /must be a YAML mapping/],
    ["invalid YAML", "a: [\n", /not valid YAML/],
    ["invalid Liquid", 'name: "{{ oops"\n', /invalid Liquid/],
  ])("refuses %s", (_what, text, message) => {
    expect(() => parseTemplate(text)).toThrow(message);
  });
});
