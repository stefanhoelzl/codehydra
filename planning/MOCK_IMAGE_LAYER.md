---
status: COMPLETED
last_updated: 2026-01-03
reviewers: [review-typescript, review-testing, review-docs]
---

# MOCK_IMAGE_LAYER

## Overview

- **Problem**: The ImageLayer behavioral mock uses the legacy `_getState()` pattern instead of the standardized `mock.$` pattern established in `src/test/state-mock.ts`. This inconsistency makes the codebase harder to maintain and learn.
- **Solution**: Migrate the ImageLayer mock to use the `$` accessor pattern with custom matchers for cleaner assertions, following the established patterns in `filesystem.state-mock.ts` and `port-manager.state-mock.ts`.
- **Risks**:
  - Test failures during migration (mitigated by updating all usages atomically)
  - Breaking existing test patterns (mitigated by keeping the same behavioral semantics)
- **Alternatives Considered**:
  - Keep `_getState()` pattern → rejected (inconsistent with other mocks, harder to maintain)
  - Direct `$` access without matchers → rejected (user preference for matcher-based assertions)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ImageLayer Mock Structure                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    ImageLayerMockState (class)                        │   │
│  │                                                                       │   │
│  │  implements MockState from src/test/state-mock.ts                     │   │
│  │                                                                       │   │
│  │  Properties:                                                          │   │
│  │  ├─ images: ReadonlyMap<string, ImageState>                          │   │
│  │                                                                       │   │
│  │  Methods:                                                             │   │
│  │  ├─ snapshot(): Snapshot                                              │   │
│  │  └─ toString(): string                                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    │ exposed via                             │
│                                    ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    MockImageLayer (type)                              │   │
│  │                                                                       │   │
│  │  = ImageLayer & MockWithState<ImageLayerMockState>                    │   │
│  │                                                                       │   │
│  │  Interface methods:        State access:                              │   │
│  │  ├─ createFromPath()       └─ $ : ImageLayerMockState                 │   │
│  │  ├─ createFromDataURL()                                               │   │
│  │  ├─ createEmpty()                                                     │   │
│  │  ├─ createFromBitmap()                                                │   │
│  │  ├─ getSize()                                                         │   │
│  │  ├─ isEmpty()                                                         │   │
│  │  ├─ toDataURL()                                                       │   │
│  │  ├─ release()                                                         │   │
│  │  └─ getNativeImage()                                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Custom Matchers                                    │   │
│  │                                                                       │   │
│  │  toHaveImage(id, properties?)  - single image check                   │   │
│  │  toHaveImages(expected[])      - exact set check (count implicit)     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Custom Matcher Specifications

Analyze current `._getState()` usage patterns in test files to determine matcher behavior.

### Migration Examples

```typescript
// Before: Check image count
expect(imageLayer._getState().images.size).toBe(0);
expect(imageLayer._getState().images.size).toBe(1);
expect(imageLayer._getState().images.size).toBe(2);

// After: Use toHaveImages with array (count implicit in length)
expect(imageLayer).toHaveImages([]);
expect(imageLayer).toHaveImages([{ id: "image-1" }]);
expect(imageLayer).toHaveImages([{ id: "image-1" }, { id: "image-2" }]);

// Before: Check specific image properties
const state = imageLayer._getState();
const image = state.images.get("image-1");
expect(image?.fromPath).toBe("/test/icon.png");
expect(image?.size).toEqual({ width: 16, height: 16 });
expect(image?.isEmpty).toBe(false);

// After: Use toHaveImage with optional properties
expect(imageLayer).toHaveImage("image-1", { fromPath: "/test/icon.png" });
expect(imageLayer).toHaveImage("image-1", { size: { width: 16, height: 16 } });
expect(imageLayer).toHaveImage("image-1", { isEmpty: false });

// Combined property check
expect(imageLayer).toHaveImage("image-1", {
  fromPath: "/test/icon.png",
  size: { width: 16, height: 16 },
  isEmpty: false,
});
```

### Matcher Type Definitions

```typescript
/**
 * Expected properties for an image in assertions.
 */
interface ImageExpectation {
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
   */
  toHaveImages(expected: ImageExpectation[]): void;
}

// Vitest module augmentation for type inference
declare module "vitest" {
  interface Assertion<T> extends ImageLayerMatchers {}
}
```

### Error Message Requirements

Matchers must return detailed error messages showing expected vs actual state:

- `toHaveImage("image-5")` failure: `Expected image "image-5" to exist, but found images: ["image-1", "image-2"]`
- `toHaveImage("image-1", { fromPath: "/a.png" })` failure: `Expected image "image-1" to have fromPath "/a.png", but got "/b.png"`
- `toHaveImages([...])` count mismatch: `Expected 2 images, but found 3: ["image-1", "image-2", "image-3"]`

## Implementation Steps

- [x] **Step 1: Create `image.state-mock.ts` with new pattern**
  - Create `src/services/platform/image.state-mock.ts`
  - Define `ImageState` interface (same as current, with `readonly` modifiers)
  - Create `ImageLayerMockState` class implementing `MockState`:
    - Private `Map<string, ImageState>` internally
    - Public `images` getter returning `ReadonlyMap`
    - `snapshot()` and `toString()` methods
  - Define `MockImageLayer` type as `ImageLayer & MockWithState<ImageLayerMockState>`
  - Implement `createImageLayerMock()` factory
  - Implement custom matchers following `MatcherImplementationsFor` pattern:
    ```typescript
    export const imageLayerMatchers: MatcherImplementationsFor<
      MockImageLayer,
      ImageLayerMatchers
    > = {
      toHaveImage(received, id, properties?) { ... },
      toHaveImages(received, expected) { ... },
    };
    ```
  - Add vitest module augmentation (`declare module "vitest"`)
  - Register matchers with `expect.extend(imageLayerMatchers)`
  - Add JSDoc with usage examples to factory and matchers
  - Files affected: `src/services/platform/image.state-mock.ts` (new)

- [x] **Step 2: Update `image.integration.test.ts`**
  - Update imports to use `createImageLayerMock` and `MockImageLayer`
  - Replace all `._getState()` calls with matcher assertions
  - Files affected: `src/services/platform/image.integration.test.ts`

- [x] **Step 3: Update `badge-manager.test.ts`**
  - Update imports to use `createImageLayerMock` and `MockImageLayer`
  - Replace all `._getState()` calls with matcher assertions
  - Files affected: `src/main/managers/badge-manager.test.ts`

- [x] **Step 4: Update `badge-manager.integration.test.ts`**
  - Update imports to use `createImageLayerMock` and `MockImageLayer`
  - Replace all `._getState()` calls with matcher assertions
  - Files affected: `src/main/managers/badge-manager.integration.test.ts`

- [x] **Step 5: Update `window-manager.test.ts`**
  - Update imports to use `createImageLayerMock`
  - Files affected: `src/main/managers/window-manager.test.ts`

- [x] **Step 6: Delete legacy `image.test-utils.ts`**
  - Remove `src/services/platform/image.test-utils.ts`

- [x] **Step 7: Update `docs/PATTERNS.md`**
  - Update mock factory table entry from `createBehavioralImageLayer()` to `createImageLayerMock()`
  - Update filename from `image.test-utils.ts` to `image.state-mock.ts`
  - Files affected: `docs/PATTERNS.md`

## Testing Strategy

No new tests required. Existing tests using this mock serve as verification that the migration preserves correct behavior.

### Manual Testing Checklist

- [ ] `pnpm validate:fix` passes
- [ ] No imports of `image.test-utils.ts` remain

## Dependencies

| Package | Purpose             | Approved |
| ------- | ------------------- | -------- |
| (none)  | No new dependencies | N/A      |

## Documentation Updates

### Files to Update

| File               | Changes Required                                                             |
| ------------------ | ---------------------------------------------------------------------------- |
| `docs/PATTERNS.md` | Update mock factory table: `createImageLayerMock()` in `image.state-mock.ts` |

### New Documentation Required

| File   | Purpose                               |
| ------ | ------------------------------------- |
| (none) | JSDoc in implementation is sufficient |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
