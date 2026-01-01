/**
 * Integration tests for ImageLayer behavioral mock.
 *
 * Tests verify the behavioral mock provides correct contract behavior
 * that matches the real DefaultImageLayer implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createBehavioralImageLayer, type BehavioralImageLayer } from "./image.test-utils";
import { createImageHandle } from "./types";
import { PlatformError } from "./errors";

describe("ImageLayer (behavioral mock)", () => {
  let imageLayer: BehavioralImageLayer;

  beforeEach(() => {
    imageLayer = createBehavioralImageLayer();
  });

  describe("createFromPath", () => {
    it("creates an image handle", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      expect(handle.id).toBe("image-1");
      expect(handle.__brand).toBe("ImageHandle");
    });

    it("stores the path in state", () => {
      imageLayer.createFromPath("/test/icon.png");
      const state = imageLayer._getState();
      const image = state.images.get("image-1");
      expect(image?.fromPath).toBe("/test/icon.png");
    });

    it("creates non-empty images", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      expect(imageLayer.isEmpty(handle)).toBe(false);
    });
  });

  describe("createFromDataURL", () => {
    it("creates an image from data URL", () => {
      const dataURL = "data:image/png;base64,iVBORw0KGgo=";
      const handle = imageLayer.createFromDataURL(dataURL);
      expect(handle.id).toBe("image-1");
      expect(imageLayer.toDataURL(handle)).toBe(dataURL);
    });
  });

  describe("createEmpty", () => {
    it("creates an empty image with specified dimensions", () => {
      const handle = imageLayer.createEmpty(32, 32);
      expect(imageLayer.isEmpty(handle)).toBe(true);
      expect(imageLayer.getSize(handle)).toEqual({ width: 32, height: 32 });
    });
  });

  describe("createFromBitmap", () => {
    it("creates an image from bitmap buffer", () => {
      const buffer = Buffer.alloc(16 * 16 * 4); // 16x16 BGRA
      const handle = imageLayer.createFromBitmap(buffer, 16, 16);
      expect(imageLayer.isEmpty(handle)).toBe(false);
      expect(imageLayer.getSize(handle)).toEqual({ width: 16, height: 16 });
    });
  });

  describe("getSize", () => {
    it("returns correct size for created image", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      // Default mock size is 16x16
      expect(imageLayer.getSize(handle)).toEqual({ width: 16, height: 16 });
    });

    it("throws for invalid handle", () => {
      const invalidHandle = createImageHandle("invalid-99");
      expect(() => imageLayer.getSize(invalidHandle)).toThrow(PlatformError);
      expect(() => imageLayer.getSize(invalidHandle)).toThrow("Invalid image handle");
    });
  });

  describe("isEmpty", () => {
    it("returns false for images created from path", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      expect(imageLayer.isEmpty(handle)).toBe(false);
    });

    it("returns true for empty images", () => {
      const handle = imageLayer.createEmpty(16, 16);
      expect(imageLayer.isEmpty(handle)).toBe(true);
    });

    it("throws for invalid handle", () => {
      const invalidHandle = createImageHandle("invalid-99");
      expect(() => imageLayer.isEmpty(invalidHandle)).toThrow(PlatformError);
    });
  });

  describe("toDataURL", () => {
    it("returns data URL for created image", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      const dataURL = imageLayer.toDataURL(handle);
      expect(dataURL).toMatch(/^data:image\/png;base64,/);
    });

    it("throws for invalid handle", () => {
      const invalidHandle = createImageHandle("invalid-99");
      expect(() => imageLayer.toDataURL(invalidHandle)).toThrow(PlatformError);
    });
  });

  describe("release", () => {
    it("removes the image from state", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      expect(imageLayer._getState().images.size).toBe(1);

      imageLayer.release(handle);
      expect(imageLayer._getState().images.size).toBe(0);
    });

    it("subsequent operations on released handle throw", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      imageLayer.release(handle);

      expect(() => imageLayer.getSize(handle)).toThrow(PlatformError);
    });
  });

  describe("getNativeImage", () => {
    it("returns null in behavioral mock", () => {
      const handle = imageLayer.createFromPath("/test/icon.png");
      expect(imageLayer.getNativeImage(handle)).toBeNull();
    });
  });

  describe("sequential IDs", () => {
    it("assigns sequential IDs to images", () => {
      const h1 = imageLayer.createFromPath("/a.png");
      const h2 = imageLayer.createFromDataURL("data:image/png;base64,test");
      const h3 = imageLayer.createEmpty(8, 8);

      expect(h1.id).toBe("image-1");
      expect(h2.id).toBe("image-2");
      expect(h3.id).toBe("image-3");
    });
  });
});
