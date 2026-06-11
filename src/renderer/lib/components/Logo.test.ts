/**
 * Tests for the Logo component.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import Logo from "./Logo.svelte";
import logo from "../../assets/logo.png";

describe("Logo component", () => {
  it("loads logo asset successfully", () => {
    // Verify the logo asset import resolves to a valid path
    expect(logo).toBeDefined();
    expect(typeof logo).toBe("string");
    // Vite asset imports resolve to paths containing the filename
    expect(logo).toContain("logo");
  });

  it("renders an img element", () => {
    const { container } = render(Logo);

    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
  });

  it("has empty alt attribute for decorative image", () => {
    const { container } = render(Logo);

    const img = container.querySelector("img");
    expect(img).toHaveAttribute("alt", "");
  });

  it("is hidden from accessibility tree", () => {
    const { container } = render(Logo);

    const img = container.querySelector("img");
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(img).toHaveAttribute("role", "presentation");
  });

  it("renders with 128px height", () => {
    const { container } = render(Logo);

    const img = container.querySelector("img");
    // Height is set via style attribute to allow width to adjust for aspect ratio
    expect(img).toHaveStyle({ height: "128px" });
  });
});
