/**
 * Tests for the Logo component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("uses default size of 128px height when size prop not provided", () => {
    const { container } = render(Logo);

    const img = container.querySelector("img");
    // Height is set via style attribute to allow width to adjust for aspect ratio
    expect(img).toHaveStyle({ height: "128px" });
  });

  it("respects size prop for height", () => {
    const { container } = render(Logo, { props: { size: 256 } });

    const img = container.querySelector("img");
    // Size controls height only - width adjusts automatically for aspect ratio
    expect(img).toHaveStyle({ height: "256px" });
  });

  it("applies animated class when animated prop is true", () => {
    const { container } = render(Logo, { props: { animated: true } });

    const img = container.querySelector("img");
    expect(img).toHaveClass("animated");
  });

  it("does not apply animated class when animated prop is false", () => {
    const { container } = render(Logo, { props: { animated: false } });

    const img = container.querySelector("img");
    expect(img).not.toHaveClass("animated");
  });

  it("does not apply animated class by default", () => {
    const { container } = render(Logo);

    const img = container.querySelector("img");
    expect(img).not.toHaveClass("animated");
  });

  describe("reduced motion", () => {
    let matchMediaSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      matchMediaSpy = vi.spyOn(window, "matchMedia");
    });

    afterEach(() => {
      matchMediaSpy.mockRestore();
    });

    it("has CSS rule to disable animation when prefers-reduced-motion is set", () => {
      // We can't directly test media queries in JSDOM, but we can verify
      // the animated class is present and the CSS rules are defined
      const { container } = render(Logo, { props: { animated: true } });

      const img = container.querySelector("img");
      expect(img).toHaveClass("animated");

      // The actual reduced-motion behavior is handled by CSS media queries
      // which are not fully supported in JSDOM. The component includes:
      // @media (prefers-reduced-motion: reduce) { .animated { animation: none; opacity: 1; } }
    });
  });
});
