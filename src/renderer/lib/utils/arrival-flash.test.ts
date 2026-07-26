import { describe, it, expect } from "vitest";
import { arrivalFlash, flashStrength } from "./arrival-flash.js";

describe("arrival-flash", () => {
  describe("flashStrength (two-pulse envelope)", () => {
    it("is zero at the endpoints and the midpoint", () => {
      expect(flashStrength(0, false)).toBeCloseTo(0);
      expect(flashStrength(0.5, false)).toBeCloseTo(0);
      expect(flashStrength(1, false)).toBeCloseTo(0);
    });

    it("peaks twice — at the quarter and three-quarter marks", () => {
      // |sin(2πt)| tops out at t = 0.25 and t = 0.75.
      expect(flashStrength(0.25, false)).toBeGreaterThan(flashStrength(0.15, false));
      expect(flashStrength(0.25, false)).toBeCloseTo(flashStrength(0.75, false));
      expect(flashStrength(0.5, false)).toBeLessThan(flashStrength(0.25, false));
    });

    it("never goes negative (absolute value of the wave)", () => {
      for (let t = 0; t <= 1; t += 0.05) {
        expect(flashStrength(t, false)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("flashStrength (reduced motion — single fade)", () => {
    it("has exactly one hump, peaking at the midpoint", () => {
      expect(flashStrength(0, true)).toBeCloseTo(0);
      expect(flashStrength(1, true)).toBeCloseTo(0);
      // sin(πt) peaks at t = 0.5, where the two-pulse curve is at a trough.
      expect(flashStrength(0.5, true)).toBeGreaterThan(flashStrength(0.25, true));
      expect(flashStrength(0.5, false)).toBeLessThan(flashStrength(0.5, true));
    });
  });

  describe("arrivalFlash transition", () => {
    const node = {} as Element;

    it("runs two pulses over the full duration by default", () => {
      const config = arrivalFlash(node, { reducedMotion: false });
      expect(config.duration).toBe(1200);
    });

    it("shortens to a single fade under reduced motion", () => {
      const config = arrivalFlash(node, { reducedMotion: true });
      expect(config.duration).toBe(400);
    });

    it("emits an inset box-shadow whose tint tracks the envelope", () => {
      const config = arrivalFlash(node, { reducedMotion: false });
      const css = config.css!;
      const atPeak = css(0.25, 0.75);
      const atTrough = css(0.5, 0.5);
      expect(atPeak).toContain("box-shadow: inset");
      expect(atPeak).toContain("color-mix");
      // Peak carries a higher tint percentage than the trough.
      const pct = (s: string): number => Number(/([\d.]+)%/.exec(s)![1]);
      expect(pct(atPeak)).toBeGreaterThan(pct(atTrough));
    });
  });
});
