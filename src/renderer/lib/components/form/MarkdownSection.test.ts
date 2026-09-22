/**
 * Tests for MarkdownSection component: rendering with heading ids, safe mode
 * (raw HTML escaped but <kbd>, images dropped), and link handling
 * (in-document anchors vs. external links).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import MarkdownSection from "./MarkdownSection.svelte";

function renderSection(content: string) {
  return render(MarkdownSection, { props: { section: { type: "markdown", content } } });
}

describe("MarkdownSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders headings with slug ids", () => {
    renderSection("# Guide\n\n## Repository hooks\n");

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Guide");
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute("id", "repository-hooks");
  });

  it("keeps <kbd>", () => {
    const { container } = renderSection("Press <kbd>Alt</kbd>+<kbd>X</kbd>\n");

    expect(container.querySelectorAll("kbd")).toHaveLength(2);
  });

  it("drops scripts and images", () => {
    const { container } = renderSection(
      'Text\n\n<script>window.hacked = true</script>\n\n![shot](screenshot.png)\n\n<img src="x" onerror="alert(1)">\n'
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("scrolls to an in-document anchor instead of navigating", async () => {
    renderSection("[Hooks](#repository-hooks)\n\n## Repository hooks\n");
    const heading = screen.getByRole("heading", { level: 2 });
    const scroll = vi.fn();
    heading.scrollIntoView = scroll;

    await fireEvent.click(screen.getByRole("link", { name: "Hooks" }));

    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("opens an external link through window.open", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderSection("[Releases](https://github.com/stefanhoelzl/codehydra/releases)\n");

    await fireEvent.click(screen.getByRole("link", { name: "Releases" }));

    expect(open).toHaveBeenCalledWith(
      "https://github.com/stefanhoelzl/codehydra/releases",
      "_blank"
    );
  });
});
