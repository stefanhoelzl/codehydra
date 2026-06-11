/**
 * Tests for TextSection component.
 * Rendering of the text styles (heading, subtitle, mono, default) and the
 * {badge:text} inline-badge syntax.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import TextSection from "./TextSection.svelte";
import type { TextSectionConfig } from "./types";

function renderSection(section: TextSectionConfig) {
  return render(TextSection, { props: { section } });
}

describe("TextSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders heading text as h1", () => {
    renderSection({ type: "text", content: "My Heading", style: "heading" });

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("My Heading");
  });

  it("renders subtitle text with subtitle class", () => {
    renderSection({ type: "text", content: "A subtitle", style: "subtitle" });

    const subtitle = document.querySelector("p.section-subtitle");
    expect(subtitle).toBeInTheDocument();
    expect(subtitle).toHaveTextContent("A subtitle");
  });

  it("renders mono text in pre element", () => {
    renderSection({ type: "text", content: "some code", style: "mono" });

    const pre = document.querySelector("pre.section-mono");
    expect(pre).toBeInTheDocument();
    expect(pre).toHaveTextContent("some code");
  });

  it("renders default text as paragraph", () => {
    renderSection({ type: "text", content: "Normal text" });

    const p = document.querySelector("p.section-text");
    expect(p).toBeInTheDocument();
    expect(p).toHaveTextContent("Normal text");
  });

  it("renders an icon before heading text", () => {
    renderSection({ type: "text", content: "Setup Failed", style: "heading", icon: "error" });

    const icon = document.querySelector(".heading-icon");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveClass("icon-error");
  });

  it("renders {badge:text} as a vscode-badge element", () => {
    renderSection({ type: "text", content: "Version {badge:v1.0} released", style: "heading" });

    const badge = document.querySelector("vscode-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("v1.0");

    // Surrounding text should also be present
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Version v1.0 released");
  });
});
