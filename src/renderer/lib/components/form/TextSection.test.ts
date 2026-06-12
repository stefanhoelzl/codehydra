/**
 * Tests for TextSection component.
 * Rendering of the text styles (heading, subtitle, default).
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
});

describe("TextSection alert styles", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders warning style as an alert box with the warning class", () => {
    renderSection({ type: "text", content: "Careful now", style: "warning" });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("section-alert", "warning");
    expect(alert).toHaveTextContent("Careful now");
  });

  it("renders error style as an alert box with the error class", () => {
    renderSection({ type: "text", content: "It broke", style: "error" });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("section-alert", "error");
    expect(alert).toHaveTextContent("It broke");
  });

  it("alert styles default to the warning icon and honor an explicit icon", () => {
    renderSection({ type: "text", content: "Default icon", style: "warning" });
    // Svelte assigns custom-element properties, not attributes.
    const defaultIcon = document.querySelector(".alert-icon vscode-icon") as HTMLElement & {
      name: string;
    };
    expect(defaultIcon.name).toBe("warning");

    document.body.innerHTML = "";
    renderSection({ type: "text", content: "Custom icon", style: "error", icon: "flame" });
    const customIcon = document.querySelector(".alert-icon vscode-icon") as HTMLElement & {
      name: string;
    };
    expect(customIcon.name).toBe("flame");
  });
});
