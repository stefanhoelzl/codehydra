/**
 * Tests for GroupSection component.
 * Pure layout container: declaration order, field cells vs bare buttons,
 * group label targeting, and align/reverse classes. Items render through the
 * renderItem snippet (stubbed here); the real recursion and child wiring are
 * covered by the Form tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import GroupSection from "./GroupSection.svelte";
import type { FormLayout, GroupItem, GroupSectionConfig } from "./types";

/** Stand-in for Form's recursive snippet: renders an identifiable stub. */
const renderItemStub = createRawSnippet<[GroupItem]>((item) => ({
  render: () => `<div class="item-stub" data-id="${item().id}"></div>`,
}));

const projectRow: GroupSectionConfig = {
  type: "group",
  label: "Project",
  items: [
    {
      type: "dropdown",
      id: "project",
      suggestions: [{ items: [{ value: "p1", label: "Project One" }] }],
    },
    { type: "button", id: "open-folder", icon: "folder-opened", title: "Open project folder" },
    { type: "button", id: "clone", icon: "source-control", title: "Clone from Git" },
  ],
};

function renderGroup(section: GroupSectionConfig, options?: { layout?: FormLayout }) {
  render(GroupSection, {
    props: {
      section,
      layout: options?.layout ?? "centered",
      renderItem: renderItemStub,
    },
  });
}

describe("GroupSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders items in declaration order, fields in stretching cells, buttons bare", () => {
    renderGroup(projectRow);

    const row = document.querySelector(".group-row");
    expect(row).toBeInTheDocument();
    const children = Array.from(row!.children);
    expect(children).toHaveLength(3);
    // The field item sits inside a .group-field cell...
    expect(children[0]).toHaveClass("group-field");
    expect(children[0]!.querySelector(".item-stub")).toHaveAttribute("data-id", "project");
    // ...while button items render bare (natural size).
    expect(children[1]).toHaveClass("item-stub");
    expect(children[1]).toHaveAttribute("data-id", "open-folder");
    expect(children[2]).toHaveAttribute("data-id", "clone");
  });

  it("renders the group label pointing at the first field's input", () => {
    renderGroup(projectRow);

    const label = document.querySelector("vscode-label");
    expect(label).toHaveTextContent("Project");
    expect(label).toHaveAttribute("for", "project-input");
  });

  it("centers a button-only group by default in the centered layout", () => {
    renderGroup({ type: "group", items: [{ type: "button", id: "ok", label: "OK" }] });

    expect(document.querySelector(".group-row")).toHaveClass("align-center");
  });

  it("left-aligns groups by default in the form layout", () => {
    renderGroup(
      { type: "group", items: [{ type: "button", id: "ok", label: "OK" }] },
      { layout: "form" }
    );

    expect(document.querySelector(".group-row")).toHaveClass("align-left");
  });

  it("applies an explicit align over the layout default", () => {
    renderGroup(
      { type: "group", align: "right", items: [{ type: "button", id: "ok", label: "OK" }] },
      { layout: "form" }
    );

    expect(document.querySelector(".group-row")).toHaveClass("align-right");
  });

  it("applies the reverse class for visually reversed rows", () => {
    renderGroup({
      type: "group",
      reverse: true,
      items: [
        { type: "button", id: "ok", label: "OK", variant: "primary" },
        { type: "button", id: "cancel", label: "Cancel", variant: "secondary" },
      ],
    });

    expect(document.querySelector(".group-row")).toHaveClass("reverse");
  });
});
