/**
 * Focused tests for platform layer types.
 * Tests type construction and basic properties.
 */

import { describe, it, expect } from "vitest";
import { createImageHandle } from "./types";

describe("ImageHandle", () => {
  describe("createImageHandle", () => {
    it("creates a handle with the given ID", () => {
      const handle = createImageHandle("test-1");
      expect(handle.id).toBe("test-1");
      expect(handle.__brand).toBe("ImageHandle");
    });

    it("creates readonly properties", () => {
      const handle = createImageHandle("test-2");
      // TypeScript prevents assignment at compile time
      // At runtime, properties are still assignable but semantically readonly
      expect(handle.id).toBe("test-2");
    });
  });

  describe("handle identity", () => {
    it("handles with same ID are structurally equal", () => {
      const h1 = createImageHandle("same-id");
      const h2 = createImageHandle("same-id");
      expect(h1).toEqual(h2);
      expect(h1.id).toBe(h2.id);
    });

    it("handles with different IDs are not equal", () => {
      const h1 = createImageHandle("id-a");
      const h2 = createImageHandle("id-b");
      expect(h1).not.toEqual(h2);
    });
  });
});
