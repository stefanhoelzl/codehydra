/**
 * Boundary tests for DefaultImageLayer.
 *
 * These tests verify the real Electron nativeImage behavior.
 * Run with: npm run test:boundary
 *
 * Contract verification: Error behaviors tested here must match
 * the behavioral mock in image.test-utils.ts
 */

// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { DefaultImageLayer } from "./image";
import { SILENT_LOGGER } from "../logging";
import { PlatformError } from "./errors";
import { createImageHandle } from "./types";

describe("DefaultImageLayer (boundary)", () => {
  let imageLayer: DefaultImageLayer;

  beforeEach(() => {
    imageLayer = new DefaultImageLayer(SILENT_LOGGER);
  });

  afterEach(() => {
    // No cleanup needed - images are just memory references
  });

  describe("createFromPath", () => {
    it("creates image from valid PNG file", () => {
      // Use the app icon as a test fixture
      const iconPath = path.resolve(process.cwd(), "resources/icon.png");
      const handle = imageLayer.createFromPath(iconPath);

      expect(handle.id).toBe("image-1");
      expect(handle.__brand).toBe("ImageHandle");

      const size = imageLayer.getSize(handle);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
      expect(imageLayer.isEmpty(handle)).toBe(false);
    });

    it("throws for non-existent path", () => {
      expect(() => imageLayer.createFromPath("/nonexistent/path.png")).toThrow(PlatformError);
      expect(() => imageLayer.createFromPath("/nonexistent/path.png")).toThrow("IMAGE_LOAD_FAILED");
    });
  });

  describe("createFromDataURL", () => {
    it("creates image from valid data URL", () => {
      // 1x1 red PNG
      const dataURL =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const handle = imageLayer.createFromDataURL(dataURL);

      expect(handle.id).toBe("image-1");
      expect(imageLayer.isEmpty(handle)).toBe(false);
    });

    it("creates empty image for empty data URL", () => {
      // Empty data URL creates an empty image
      const handle = imageLayer.createFromDataURL("");
      expect(imageLayer.isEmpty(handle)).toBe(true);
    });
  });

  describe("createEmpty", () => {
    it("creates an empty image", () => {
      const handle = imageLayer.createEmpty(16, 16);
      expect(imageLayer.isEmpty(handle)).toBe(true);
    });
  });

  describe("createFromBitmap", () => {
    it("creates image from BGRA buffer", () => {
      // 2x2 image, BGRA format (4 bytes per pixel)
      const width = 2;
      const height = 2;
      const buffer = Buffer.alloc(width * height * 4);

      // Fill with red (BGRA: 0, 0, 255, 255)
      for (let i = 0; i < width * height; i++) {
        buffer[i * 4] = 0; // B
        buffer[i * 4 + 1] = 0; // G
        buffer[i * 4 + 2] = 255; // R
        buffer[i * 4 + 3] = 255; // A
      }

      const handle = imageLayer.createFromBitmap(buffer, width, height);
      expect(imageLayer.isEmpty(handle)).toBe(false);
      expect(imageLayer.getSize(handle)).toEqual({ width: 2, height: 2 });
    });
  });

  describe("getSize", () => {
    it("returns correct size for loaded image", () => {
      const iconPath = path.resolve(process.cwd(), "resources/icon.png");
      const handle = imageLayer.createFromPath(iconPath);
      const size = imageLayer.getSize(handle);

      // icon.png should be 256x256 or similar
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    });

    it("throws for invalid handle", () => {
      const invalidHandle = createImageHandle("nonexistent-99");
      expect(() => imageLayer.getSize(invalidHandle)).toThrow(PlatformError);
      expect(() => imageLayer.getSize(invalidHandle)).toThrow("Invalid image handle");
    });
  });

  describe("toDataURL", () => {
    it("returns data URL string", () => {
      const iconPath = path.resolve(process.cwd(), "resources/icon.png");
      const handle = imageLayer.createFromPath(iconPath);
      const dataURL = imageLayer.toDataURL(handle);

      expect(dataURL).toMatch(/^data:image\/png;base64,/);
    });
  });

  describe("release", () => {
    it("removes image from internal map", () => {
      const iconPath = path.resolve(process.cwd(), "resources/icon.png");
      const handle = imageLayer.createFromPath(iconPath);

      // Should work before release
      expect(imageLayer.isEmpty(handle)).toBe(false);

      // Release
      imageLayer.release(handle);

      // Should throw after release
      expect(() => imageLayer.getSize(handle)).toThrow(PlatformError);
    });
  });

  describe("getNativeImage", () => {
    it("returns NativeImage for valid handle", () => {
      const iconPath = path.resolve(process.cwd(), "resources/icon.png");
      const handle = imageLayer.createFromPath(iconPath);
      const nativeImage = imageLayer.getNativeImage(handle);

      expect(nativeImage).not.toBeNull();
      expect(nativeImage!.isEmpty()).toBe(false);
    });

    it("returns null for invalid handle", () => {
      const invalidHandle = createImageHandle("nonexistent-99");
      expect(imageLayer.getNativeImage(invalidHandle)).toBeNull();
    });
  });
});
