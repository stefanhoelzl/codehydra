/**
 * Common types for platform layer abstractions.
 *
 * These branded types provide type-safe handles that prevent
 * accidental mixing of different handle types at compile time.
 */

/**
 * Opaque handle to a native image.
 * Used by ImageBoundary to reference NativeImage instances without exposing Electron types.
 */
export interface ImageHandle {
  readonly id: string;
  readonly __brand: "ImageHandle";
}

/**
 * Creates an ImageHandle with the given ID.
 * Used by layer implementations to create handles.
 */
export function createImageHandle(id: string): ImageHandle {
  return { id, __brand: "ImageHandle" };
}
