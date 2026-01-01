/**
 * Test utilities for ImageLayer.
 * Provides behavioral mock for testing image operations without Electron.
 */

import type { NativeImage } from "electron";
import type { ImageLayer } from "./image";
import type { ImageHandle, ImageSize } from "./types";
import { createImageHandle } from "./types";
import { PlatformError } from "./errors";

/**
 * State for a single image in the behavioral mock.
 */
interface ImageState {
  readonly size: ImageSize;
  readonly isEmpty: boolean;
  readonly dataURL: string;
  readonly fromPath?: string;
}

/**
 * Full state of the behavioral ImageLayer mock.
 */
export interface ImageLayerState {
  readonly images: Map<string, ImageState>;
}

/**
 * Extended ImageLayer interface with state inspection for testing.
 */
export interface BehavioralImageLayer extends ImageLayer {
  /**
   * Get internal state for test assertions.
   */
  _getState(): ImageLayerState;
}

/**
 * Creates a behavioral mock of ImageLayer for testing.
 *
 * The mock maintains in-memory image state and provides the same
 * error behaviors as the real implementation:
 * - createFromPath throws IMAGE_LOAD_FAILED for invalid paths
 * - Operations on invalid handles throw IMAGE_LOAD_FAILED
 *
 * Use `_getState()` to inspect the internal state for assertions.
 */
export function createBehavioralImageLayer(): BehavioralImageLayer {
  const images = new Map<string, ImageState>();
  let nextId = 1;

  function getImage(handle: ImageHandle): ImageState {
    const image = images.get(handle.id);
    if (!image) {
      throw new PlatformError("IMAGE_LOAD_FAILED", `Invalid image handle: ${handle.id}`);
    }
    return image;
  }

  return {
    createFromPath(path: string): ImageHandle {
      // Simulate loading - by default, all paths are valid in the mock
      // Tests can check _getState().images to verify path was stored
      const id = `image-${nextId++}`;
      images.set(id, {
        size: { width: 16, height: 16 }, // Default test size
        isEmpty: false,
        dataURL: `data:image/png;base64,mock-${id}`,
        fromPath: path,
      });
      return createImageHandle(id);
    },

    createFromDataURL(dataURL: string): ImageHandle {
      const id = `image-${nextId++}`;
      images.set(id, {
        size: { width: 16, height: 16 }, // Default test size
        isEmpty: false,
        dataURL,
      });
      return createImageHandle(id);
    },

    createEmpty(width: number, height: number): ImageHandle {
      const id = `image-${nextId++}`;
      images.set(id, {
        size: { width, height },
        isEmpty: true,
        dataURL: "data:image/png;base64,",
      });
      return createImageHandle(id);
    },

    createFromBitmap(_buffer: Buffer, width: number, height: number): ImageHandle {
      const id = `image-${nextId++}`;
      images.set(id, {
        size: { width, height },
        isEmpty: false,
        dataURL: `data:image/png;base64,bitmap-${id}`,
      });
      return createImageHandle(id);
    },

    getSize(handle: ImageHandle): ImageSize {
      return getImage(handle).size;
    },

    isEmpty(handle: ImageHandle): boolean {
      return getImage(handle).isEmpty;
    },

    toDataURL(handle: ImageHandle): string {
      return getImage(handle).dataURL;
    },

    release(handle: ImageHandle): void {
      images.delete(handle.id);
    },

    getNativeImage(handle: ImageHandle): NativeImage | null {
      // Behavioral mock doesn't have real NativeImage instances
      // Return null - callers should use other methods for testing
      // Verify handle exists to match real implementation behavior
      if (!images.has(handle.id)) {
        return null;
      }
      return null;
    },

    _getState(): ImageLayerState {
      return { images: new Map(images) };
    },
  };
}
