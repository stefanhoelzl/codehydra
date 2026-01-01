/**
 * ImageLayer - Abstraction over Electron's nativeImage.
 *
 * Provides an injectable interface for image management, enabling:
 * - Unit testing with behavioral mocks
 * - Boundary testing against real nativeImage
 * - Handle-based access pattern (no direct Electron types exposed)
 */

import type { NativeImage } from "electron";
import type { ImageHandle, ImageSize } from "./types";
import { createImageHandle } from "./types";
import { PlatformError } from "./errors";
import type { Logger } from "../logging";

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstraction over Electron's nativeImage module.
 *
 * Uses opaque ImageHandle references instead of exposing NativeImage directly.
 * This allows testing without Electron dependencies and ensures all image
 * access goes through this abstraction.
 */
export interface ImageLayer {
  /**
   * Create an image from a file path.
   *
   * @param path - Absolute path to the image file
   * @returns Handle to the created image
   * @throws PlatformError with code IMAGE_LOAD_FAILED if file cannot be loaded
   */
  createFromPath(path: string): ImageHandle;

  /**
   * Create an image from a data URL.
   *
   * @param dataURL - Base64-encoded data URL (e.g., "data:image/png;base64,...")
   * @returns Handle to the created image
   */
  createFromDataURL(dataURL: string): ImageHandle;

  /**
   * Create an empty image with the given dimensions.
   *
   * @param width - Width in pixels
   * @param height - Height in pixels
   * @returns Handle to the created empty image
   */
  createEmpty(width: number, height: number): ImageHandle;

  /**
   * Create an image from raw BGRA bitmap data.
   *
   * @param buffer - Raw pixel data in BGRA format
   * @param width - Width in pixels
   * @param height - Height in pixels
   * @returns Handle to the created image
   */
  createFromBitmap(buffer: Buffer, width: number, height: number): ImageHandle;

  /**
   * Get the size of an image.
   *
   * @param handle - Handle to the image
   * @returns The image dimensions
   * @throws PlatformError with code IMAGE_LOAD_FAILED if handle is invalid
   */
  getSize(handle: ImageHandle): ImageSize;

  /**
   * Check if an image is empty (has no content).
   *
   * @param handle - Handle to the image
   * @returns True if the image is empty
   * @throws PlatformError with code IMAGE_LOAD_FAILED if handle is invalid
   */
  isEmpty(handle: ImageHandle): boolean;

  /**
   * Convert an image to a data URL.
   *
   * @param handle - Handle to the image
   * @returns Base64-encoded data URL
   * @throws PlatformError with code IMAGE_LOAD_FAILED if handle is invalid
   */
  toDataURL(handle: ImageHandle): string;

  /**
   * Release an image handle and free associated resources.
   *
   * @param handle - Handle to release
   */
  release(handle: ImageHandle): void;

  /**
   * Get the underlying NativeImage for Electron API interop.
   * This is only used when passing images to Electron APIs that require NativeImage.
   *
   * @param handle - Handle to the image
   * @returns The underlying NativeImage, or null if handle is invalid
   */
  getNativeImage(handle: ImageHandle): NativeImage | null;
}

// ============================================================================
// Default Implementation
// ============================================================================

import { nativeImage } from "electron";

/**
 * Default implementation of ImageLayer using Electron's nativeImage.
 */
export class DefaultImageLayer implements ImageLayer {
  private readonly images = new Map<string, NativeImage>();
  private nextId = 1;

  constructor(private readonly logger: Logger) {}

  createFromPath(path: string): ImageHandle {
    const image = nativeImage.createFromPath(path);
    if (image.isEmpty()) {
      throw new PlatformError("IMAGE_LOAD_FAILED", `Failed to load image from path: ${path}`);
    }

    const id = `image-${this.nextId++}`;
    this.images.set(id, image);
    this.logger.debug("Image created from path", { id, path });
    return createImageHandle(id);
  }

  createFromDataURL(dataURL: string): ImageHandle {
    const image = nativeImage.createFromDataURL(dataURL);
    const id = `image-${this.nextId++}`;
    this.images.set(id, image);
    this.logger.debug("Image created from data URL", { id });
    return createImageHandle(id);
  }

  createEmpty(width: number, height: number): ImageHandle {
    const image = nativeImage.createEmpty();
    const id = `image-${this.nextId++}`;
    this.images.set(id, image);
    this.logger.debug("Empty image created", { id, width, height });
    return createImageHandle(id);
  }

  createFromBitmap(buffer: Buffer, width: number, height: number): ImageHandle {
    const image = nativeImage.createFromBitmap(buffer, { width, height });
    const id = `image-${this.nextId++}`;
    this.images.set(id, image);
    this.logger.debug("Image created from bitmap", { id, width, height });
    return createImageHandle(id);
  }

  getSize(handle: ImageHandle): ImageSize {
    const image = this.getImage(handle);
    return image.getSize();
  }

  isEmpty(handle: ImageHandle): boolean {
    const image = this.getImage(handle);
    return image.isEmpty();
  }

  toDataURL(handle: ImageHandle): string {
    const image = this.getImage(handle);
    return image.toDataURL();
  }

  release(handle: ImageHandle): void {
    if (this.images.delete(handle.id)) {
      this.logger.debug("Image released", { id: handle.id });
    }
  }

  getNativeImage(handle: ImageHandle): NativeImage | null {
    return this.images.get(handle.id) ?? null;
  }

  private getImage(handle: ImageHandle): NativeImage {
    const image = this.images.get(handle.id);
    if (!image) {
      throw new PlatformError("IMAGE_LOAD_FAILED", `Invalid image handle: ${handle.id}`);
    }
    return image;
  }
}
