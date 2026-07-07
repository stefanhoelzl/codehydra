import { describe, it, expect } from "vitest";
import { renderTemplate, isValidLiquidTemplate } from "./liquid-renderer";

describe("renderTemplate", () => {
  it("substitutes simple variables", () => {
    expect(renderTemplate("PR: {{ title }}", { title: "Add login feature" })).toBe(
      "PR: Add login feature"
    );
  });

  it("accesses nested properties", () => {
    const data = { head: { ref: "feature-login" } };
    expect(renderTemplate("Branch: {{ head.ref }}", data)).toBe("Branch: feature-login");
  });

  it("renders missing variables as empty string", () => {
    expect(renderTemplate("Value: [{{ missing }}]", {})).toBe("Value: []");
  });

  it("supports filters", () => {
    const data = { body: "A very long description that should be truncated" };
    const result = renderTemplate("{{ body | truncate: 20 }}", data);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("supports conditionals", () => {
    expect(renderTemplate("{% if draft %}DRAFT{% endif %}", { draft: true })).toBe("DRAFT");
    expect(renderTemplate("{% if draft %}DRAFT{% endif %}", { draft: false })).toBe("");
  });

  it("handles numeric values", () => {
    expect(renderTemplate("#{{ number }}", { number: 42 })).toBe("#42");
  });
});

describe("isValidLiquidTemplate", () => {
  it("accepts valid Liquid (including plain text and front-matter bodies)", () => {
    expect(isValidLiquidTemplate("plain text, no tags")).toBe(true);
    expect(isValidLiquidTemplate("---\nname: {{ title }}\n---\nReview {{ number }}")).toBe(true);
    expect(isValidLiquidTemplate("{% if draft %}DRAFT{% endif %}")).toBe(true);
    expect(isValidLiquidTemplate("")).toBe(true);
  });

  it("rejects malformed Liquid syntax", () => {
    expect(isValidLiquidTemplate("{% if draft %}unclosed")).toBe(false);
    expect(isValidLiquidTemplate("{{ unclosed")).toBe(false);
  });
});
