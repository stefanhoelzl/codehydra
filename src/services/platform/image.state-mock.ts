/**
 * Behavioral mock for ImageLayer with stateful testing support.
 *
 * Provides a stateful mock that simulates real ImageLayer behavior:
 * - In-memory image storage with handle management
 * - Proper error handling for invalid handles
 * - Custom matchers for behavioral assertions
 *
 * @example
 * const imageLayer = createImageLayerMock();
 *
 * // Create images via the mock interface
 * const handle = imageLayer.createFromPath("/icons/app.png");
 *
 * // Assert using custom matchers
 * expect(imageLayer).toHaveImage("image-1", { fromPath: "/icons/app.png" });
 * expect(imageLayer).toHaveImages([{ id: "image-1" }]);
 */

import { expect } from "vitest";
import type { NativeImage } from "electron";
import type { ImageLayer } from "./image";
import type { ImageHandle, ImageSize } from "./types";
import { createImageHandle } from "./types";
import { PlatformError } from "./errors";
import type {
  MockState,
  MockWithState,
  Snapshot,
  MatcherImplementationsFor,
} from "../../test/state-mock";

// =============================================================================
// State Types
// =============================================================================

/**
 * State for a single image in the behavioral mock.
 */
export interface ImageState {
  readonly size: ImageSize;
  readonly isEmpty: boolean;
  readonly dataURL: string;
  readonly fromPath?: string;
}

// =============================================================================
// State Implementation
// =============================================================================

/**
 * Mock state for ImageLayer.
 * Implements MockState for snapshot/toString support.
 */
export class ImageLayerMockState implements MockState {
  private readonly _images: Map<string, ImageState>;

  constructor(initialImages?: Map<string, ImageState>) {
    this._images = new Map(initialImages);
  }

  /**
   * Read-only access to all images.
   * Keys are image handle IDs (e.g., "image-1").
   */
  get images(): ReadonlyMap<string, ImageState> {
    return this._images;
  }

  /**
   * Internal method to add an image.
   * @internal
   */
  _setImage(id: string, state: ImageState): void {
    this._images.set(id, state);
  }

  /**
   * Internal method to remove an image.
   * @internal
   */
  _deleteImage(id: string): boolean {
    return this._images.delete(id);
  }

  snapshot(): Snapshot {
    return { __brand: "Snapshot", value: this.toString() } as Snapshot;
  }

  toString(): string {
    const sorted = [...this._images.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines = sorted.map(([id, state]) => {
      const parts = [`size=${state.size.width}x${state.size.height}`, `isEmpty=${state.isEmpty}`];
      if (state.fromPath) {
        parts.push(`fromPath=${state.fromPath}`);
      }
      return `${id}: ${parts.join(", ")}`;
    });
    return lines.length > 0 ? lines.join("\n") : "(no images)";
  }
}

// =============================================================================
// Mock Type
// =============================================================================

/**
 * ImageLayer with behavioral mock state access via `$` property.
 */
export type MockImageLayer = ImageLayer & MockWithState<ImageLayerMockState>;

// =============================================================================
// Factory Implementation
// =============================================================================

/**
 * Create a behavioral mock for ImageLayer.
 *
 * The mock maintains in-memory image state and provides the same
 * error behaviors as the real implementation:
 * - createFromPath stores the path for later verification
 * - Operations on invalid handles throw PlatformError
 *
 * Use `$` property to access state for assertions.
 *
 * @example Basic usage
 * ```typescript
 * const imageLayer = createImageLayerMock();
 * const handle = imageLayer.createFromPath("/icons/app.png");
 *
 * expect(imageLayer).toHaveImage("image-1", { fromPath: "/icons/app.png" });
 * expect(imageLayer).toHaveImages([{ id: "image-1" }]);
 * ```
 *
 * @example Checking image count
 * ```typescript
 * const imageLayer = createImageLayerMock();
 * imageLayer.createFromPath("/a.png");
 * imageLayer.createFromPath("/b.png");
 *
 * expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);
 * ```
 *
 * @example Verifying release behavior
 * ```typescript
 * const imageLayer = createImageLayerMock();
 * const handle = imageLayer.createFromPath("/icon.png");
 * imageLayer.release(handle);
 *
 * expect(imageLayer).toHaveImages([]);
 * ```
 */
export function createImageLayerMock(): MockImageLayer {
  const state = new ImageLayerMockState();
  let nextId = 1;

  function getImage(handle: ImageHandle): ImageState {
    const image = state.images.get(handle.id);
    if (!image) {
      throw new PlatformError("IMAGE_LOAD_FAILED", `Invalid image handle: ${handle.id}`);
    }
    return image;
  }

  const layer: ImageLayer = {
    createFromPath(path: string): ImageHandle {
      const id = `image-${nextId++}`;
      state._setImage(id, {
        size: { width: 16, height: 16 }, // Default test size
        isEmpty: false,
        dataURL: `data:image/png;base64,mock-${id}`,
        fromPath: path,
      });
      return createImageHandle(id);
    },

    createFromDataURL(dataURL: string): ImageHandle {
      const id = `image-${nextId++}`;
      state._setImage(id, {
        size: { width: 16, height: 16 }, // Default test size
        isEmpty: false,
        dataURL,
      });
      return createImageHandle(id);
    },

    createEmpty(width: number, height: number): ImageHandle {
      const id = `image-${nextId++}`;
      state._setImage(id, {
        size: { width, height },
        isEmpty: true,
        dataURL: "data:image/png;base64,",
      });
      return createImageHandle(id);
    },

    createFromBitmap(_buffer: Buffer, width: number, height: number): ImageHandle {
      const id = `image-${nextId++}`;
      state._setImage(id, {
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
      state._deleteImage(handle.id);
    },

    getNativeImage(handle: ImageHandle): NativeImage | null {
      // Behavioral mock doesn't have real NativeImage instances
      // Return null - callers should use other methods for testing
      // Verify handle exists to match real implementation behavior
      if (!state.images.has(handle.id)) {
        return null;
      }
      return null;
    },
  };

  return Object.assign(layer, { $: state });
}

// =============================================================================
// Custom Matchers
// =============================================================================

/**
 * Expected properties for an image in assertions.
 */
export interface ImageExpectation {
  id: string;
  size?: ImageSize;
  isEmpty?: boolean;
  fromPath?: string;
}

/**
 * Custom matchers for ImageLayer mock assertions.
 */
interface ImageLayerMatchers {
  /**
   * Assert that a specific image exists with optional property checks.
   * Does NOT verify total count - use toHaveImages for exact set matching.
   *
   * @param id - Image handle ID (e.g., "image-1")
   * @param properties - Optional partial ImageState to match
   *
   * @example
   * expect(imageLayer).toHaveImage("image-1");
   * expect(imageLayer).toHaveImage("image-1", { fromPath: "/icon.png" });
   * expect(imageLayer).toHaveImage("image-1", { size: { width: 16, height: 16 } });
   */
  toHaveImage(id: string, properties?: Omit<ImageExpectation, "id">): void;

  /**
   * Assert the exact set of images. Count is implicit in array length.
   *
   * @param expected - Array of image expectations (empty array = no images)
   *
   * @example
   * expect(imageLayer).toHaveImages([]);
   * expect(imageLayer).toHaveImages([{ id: "image-1", fromPath: "/icon.png" }]);
   * expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);
   */
  toHaveImages(expected: ImageExpectation[]): void;
}

declare module "vitest" {
  interface Assertion<T> extends ImageLayerMatchers {}
}

export const imageLayerMatchers: MatcherImplementationsFor<MockImageLayer, ImageLayerMatchers> = {
  toHaveImage(received, id, properties?) {
    const image = received.$.images.get(id);
    const allImageIds = [...received.$.images.keys()];

    if (!image) {
      return {
        pass: false,
        message: () =>
          `Expected image "${id}" to exist, but found images: [${allImageIds.map((i) => `"${i}"`).join(", ")}]`,
      };
    }

    // Check optional properties
    if (properties) {
      if (properties.fromPath !== undefined && image.fromPath !== properties.fromPath) {
        return {
          pass: false,
          message: () =>
            `Expected image "${id}" to have fromPath "${properties.fromPath}", but got "${image.fromPath}"`,
        };
      }

      if (properties.size !== undefined) {
        if (
          image.size.width !== properties.size.width ||
          image.size.height !== properties.size.height
        ) {
          return {
            pass: false,
            message: () =>
              `Expected image "${id}" to have size ${properties.size?.width}x${properties.size?.height}, but got ${image.size.width}x${image.size.height}`,
          };
        }
      }

      if (properties.isEmpty !== undefined && image.isEmpty !== properties.isEmpty) {
        return {
          pass: false,
          message: () =>
            `Expected image "${id}" to have isEmpty=${properties.isEmpty}, but got isEmpty=${image.isEmpty}`,
        };
      }
    }

    return {
      pass: true,
      message: () => `Expected image "${id}" not to exist`,
    };
  },

  toHaveImages(received, expected) {
    const actualCount = received.$.images.size;
    const expectedCount = expected.length;
    const allImageIds = [...received.$.images.keys()];

    // Check count first
    if (actualCount !== expectedCount) {
      return {
        pass: false,
        message: () =>
          `Expected ${expectedCount} images, but found ${actualCount}: [${allImageIds.map((i) => `"${i}"`).join(", ")}]`,
      };
    }

    // Check each expected image exists with correct properties
    for (const expectation of expected) {
      const image = received.$.images.get(expectation.id);

      if (!image) {
        return {
          pass: false,
          message: () =>
            `Expected image "${expectation.id}" to exist, but found images: [${allImageIds.map((i) => `"${i}"`).join(", ")}]`,
        };
      }

      // Check optional properties
      if (expectation.fromPath !== undefined && image.fromPath !== expectation.fromPath) {
        return {
          pass: false,
          message: () =>
            `Expected image "${expectation.id}" to have fromPath "${expectation.fromPath}", but got "${image.fromPath}"`,
        };
      }

      if (expectation.size !== undefined) {
        if (
          image.size.width !== expectation.size.width ||
          image.size.height !== expectation.size.height
        ) {
          return {
            pass: false,
            message: () =>
              `Expected image "${expectation.id}" to have size ${expectation.size?.width}x${expectation.size?.height}, but got ${image.size.width}x${image.size.height}`,
          };
        }
      }

      if (expectation.isEmpty !== undefined && image.isEmpty !== expectation.isEmpty) {
        return {
          pass: false,
          message: () =>
            `Expected image "${expectation.id}" to have isEmpty=${expectation.isEmpty}, but got isEmpty=${image.isEmpty}`,
        };
      }
    }

    return {
      pass: true,
      message: () => `Expected not to have exactly these ${expectedCount} images`,
    };
  },
};

// Register matchers with expect
expect.extend(imageLayerMatchers);
