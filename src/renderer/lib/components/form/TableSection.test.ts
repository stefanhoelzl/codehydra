/**
 * Tests for TableSection component.
 * Rendering of the data table, column headers, and the optional header line.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import TableSection from "./TableSection.svelte";
import type { TableSectionConfig } from "./types";

function renderSection(section: TableSectionConfig) {
  return render(TableSection, { props: { section } });
}

describe("TableSection component", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders table with header and rows", () => {
    renderSection({
      type: "table",
      header: "Details",
      columns: [
        { key: "name", label: "Name" },
        { key: "value", label: "Value" },
      ],
      rows: [
        { name: "Version", value: "1.0.0" },
        { name: "Size", value: "4.2 MB" },
      ],
    });

    // Table header text
    expect(screen.getByText("Details")).toBeInTheDocument();

    // Column headers
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Value")).toBeInTheDocument();

    // Row data
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("4.2 MB")).toBeInTheDocument();
  });

  it("renders an empty cell for a row missing a column key", () => {
    renderSection({
      type: "table",
      columns: [
        { key: "name", label: "Name" },
        { key: "value", label: "Value" },
      ],
      rows: [{ name: "Orphan" }],
    });

    const cells = document.querySelectorAll("tbody td");
    expect(cells).toHaveLength(2);
    expect(cells[1]).toHaveTextContent("");
  });
});
