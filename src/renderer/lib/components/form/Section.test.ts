/**
 * Tests for the Section dispatcher.
 * One assertion per section type: the config routes to the right leaf
 * component (group items route through the renderItem snippet). Leaf
 * behavior is covered by the per-leaf tests; the full group recursion is
 * covered by the Form tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import Section from "./Section.svelte";
import type { DialogSection } from "@shared/dialog-types";
import type { ButtonItem } from "./types";

/** Stand-in for Form's recursive snippet: renders an identifiable stub. */
const renderItemStub = createRawSnippet<[DialogSection | ButtonItem]>((item) => ({
  render: () => {
    const s = item();
    return `<div class="item-stub" data-id="${"id" in s ? s.id : ""}"></div>`;
  },
}));

function renderSection(section: DialogSection | ButtonItem) {
  render(Section, {
    props: {
      section,
      layout: "centered",
      values: {},
      displays: {},
      renderItem: renderItemStub,
      onInput: vi.fn(),
      onSelect: vi.fn(),
      onPick: vi.fn(),
      onType: vi.fn(),
      onToggle: vi.fn(),
      onAction: vi.fn(),
      onSubmit: vi.fn(),
    },
  });
}

describe("Section dispatcher", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("routes text sections to TextSection", () => {
    renderSection({ type: "text", content: "Hello", style: "heading" });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hello");
  });

  it("routes progress sections to ProgressSection", () => {
    renderSection({ type: "progress", items: [{ id: "s", label: "Step", status: "running" }] });

    expect(document.querySelector(".progress-container")).toBeInTheDocument();
  });

  it("routes radio sections to RadioSection", () => {
    renderSection({ type: "radio", id: "choice", options: [{ id: "a", label: "A" }] });

    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });

  it("routes dropdown sections to DropdownSection", () => {
    renderSection({ type: "dropdown", id: "region", suggestions: [] });

    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("routes input sections to InputSection", () => {
    renderSection({ type: "input", id: "url" });

    expect(document.querySelector("vscode-textfield")).toBeInTheDocument();
  });

  it("routes table sections to TableSection", () => {
    renderSection({ type: "table", columns: [{ key: "k", label: "K" }], rows: [] });

    expect(document.querySelector("table")).toBeInTheDocument();
  });

  it("routes button items to FormButton", () => {
    renderSection({ type: "button", id: "go", label: "Go" });

    expect(document.querySelector("vscode-button")).toHaveTextContent("Go");
  });

  it("routes group sections to GroupSection, rendering items via the snippet", () => {
    renderSection({
      type: "group",
      items: [
        { type: "input", id: "url" },
        { type: "button", id: "go", label: "Go" },
      ],
    });

    const row = document.querySelector(".group-row");
    expect(row).toBeInTheDocument();
    const stubs = row!.querySelectorAll(".item-stub");
    expect(stubs).toHaveLength(2);
    expect(stubs[0]).toHaveAttribute("data-id", "url");
    expect(stubs[1]).toHaveAttribute("data-id", "go");
  });
});
