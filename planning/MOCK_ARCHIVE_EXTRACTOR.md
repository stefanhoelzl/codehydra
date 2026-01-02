---
status: COMPLETED
last_updated: 2026-01-03
reviewers: [review-typescript, review-testing, review-docs]
---

# MOCK_ARCHIVE_EXTRACTOR

## Overview

- **Problem**: The existing `createMockArchiveExtractor` uses call-tracking mocks (`vi.fn()`) which test implementation details rather than behavior. This doesn't follow the behavioral mock pattern established in `docs/TESTING.md`.
- **Solution**: Create a behavioral state mock following the `mock.$` pattern used by `HttpClient`, `PortManager`, and `FileSystemLayer` mocks.
- **Risks**:
  - Path normalization edge cases on Windows vs Unix
  - Mitigated by using the existing `Path` class
- **Alternatives Considered**:
  - Coordinated mock that integrates with FileSystemMock to create files during extraction - rejected as it adds coupling and complexity. Keep mocks decoupled.

## Boundary Test Contract

The mock must replicate error scenarios verified by `archive-extractor.boundary.test.ts`:

| Error Code          | Scenario            | Example                   |
| ------------------- | ------------------- | ------------------------- |
| `INVALID_ARCHIVE`   | Corrupt archive     | Invalid tar.gz/zip data   |
| `INVALID_ARCHIVE`   | Unsupported format  | `.rar`, `.7z` extensions  |
| `PERMISSION_DENIED` | Write access denied | EACCES/EPERM errors       |
| `EXTRACTION_FAILED` | Other failures      | General extraction errors |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  MockArchiveExtractor                        │
├─────────────────────────────────────────────────────────────┤
│  Interface: ArchiveExtractor                                 │
│  ├─ extract(archivePath, destDir): Promise<void>            │
│                                                              │
│  State ($): ArchiveExtractorMockState                       │
│  ├─ extractions: readonly ExtractionRecord[]                │
│  ├─ snapshot(): Snapshot                                    │
│  └─ toString(): string                                      │
│                                                              │
│  Configuration (via factory):                                │
│  ├─ results: Record<path, ExtractionResult>                 │
│  └─ defaultResult: ExtractionResult                         │
└─────────────────────────────────────────────────────────────┘

Types:
┌─────────────────────────────────────────────────────────────┐
│  ExtractionRecord (tracks what was extracted)               │
│  ├─ archivePath: string  (normalized via Path class)        │
│  ├─ destDir: string      (normalized via Path class)        │
│  └─ timestamp: number                                       │
├─────────────────────────────────────────────────────────────┤
│  ExtractionResult (configures behavior)                     │
│  └─ error?: { message: string, code: ArchiveErrorCode }     │
└─────────────────────────────────────────────────────────────┘

Configuration behavior:
- If path found in results → use that ExtractionResult
- If path not found → use defaultResult
- If defaultResult undefined → succeed (no-op, record extraction)

Custom Matchers (use normalized Path comparison):
┌─────────────────────────────────────────────────────────────┐
│  toHaveExtracted(archivePath, destDir)                      │
│  toHaveNoExtractions()                                      │
└─────────────────────────────────────────────────────────────┘
```

## Usage Examples

```typescript
// Basic usage - succeeds for all extractions
const extractor = createArchiveExtractorMock();
await extractor.extract("/tmp/app.tar.gz", "/opt/app");
expect(extractor).toHaveExtracted("/tmp/app.tar.gz", "/opt/app");

// Error case - all extractions fail
const extractor = createArchiveExtractorMock({
  defaultResult: { error: { message: "Corrupt", code: "INVALID_ARCHIVE" } },
});
await expect(extractor.extract("/bad.zip", "/dest")).rejects.toThrow();
expect(extractor).toHaveNoExtractions();

// Per-path configuration
const extractor = createArchiveExtractorMock({
  results: {
    "/bad.zip": { error: { message: "Invalid", code: "INVALID_ARCHIVE" } },
  },
});
await extractor.extract("/good.tar.gz", "/dest1"); // succeeds
await expect(extractor.extract("/bad.zip", "/dest2")).rejects.toThrow();
expect(extractor).toHaveExtracted("/good.tar.gz", "/dest1");
```

## Implementation Steps

- [x] **Step 1: Create state mock file**
  - Create `src/services/binary-download/archive-extractor.state-mock.ts`
  - File naming follows `*.state-mock.ts` pattern from `docs/TESTING.md` (State Mock Pattern)
  - Implement types:

    ```typescript
    interface ExtractionRecord {
      readonly archivePath: string;
      readonly destDir: string;
      readonly timestamp: number;
    }

    interface ExtractionResult {
      readonly error?: {
        readonly message: string;
        readonly code: ArchiveErrorCode;
      };
    }

    interface ArchiveExtractorMockState extends MockState {
      readonly extractions: readonly ExtractionRecord[];
    }
    ```

  - Implement `createArchiveExtractorMock` factory with JSDoc `@example` blocks
  - Use `Path` class for normalizing paths (cross-platform consistency for Windows/Unix)
  - Implement custom matchers with normalized Path comparison
  - Add vitest module augmentation for TypeScript support:
    ```typescript
    declare module "vitest" {
      interface Assertion<T> extends ArchiveExtractorMatchers {}
    }
    ```
  - Auto-register matchers via `expect.extend()`
  - Extractions array tracks order (for sequential verification if needed)
  - `snapshot()` returns string representation of extractions count and paths
  - Files affected: `src/services/binary-download/archive-extractor.state-mock.ts` (new)

- [x] **Step 2: Migrate existing tests**
  - Update `binary-download-service.test.ts` to use `createArchiveExtractorMock`
  - Remove tests for the old mock factory from `archive-extractor.test.ts`
  - Note: Old mock had tests (`describe("createMockArchiveExtractor", ...)`), new mock validates through usage in service tests - this is intentional per project convention
  - Files affected:
    - `src/services/binary-download/binary-download-service.test.ts`
    - `src/services/binary-download/archive-extractor.test.ts`

- [x] **Step 3: Remove legacy mock**
  - Delete `src/services/binary-download/archive-extractor.test-utils.ts`
  - Update exports in `src/services/binary-download/index.ts`
  - Files affected:
    - `src/services/binary-download/archive-extractor.test-utils.ts` (delete)
    - `src/services/binary-download/index.ts`

- [x] **Step 4: Update documentation**
  - Add ArchiveExtractor entry to test utils location table in `docs/PATTERNS.md`
  - Location: Service Layer Patterns → Test utils location table (~line 933)
  - Add row: `| ArchiveExtractor | createArchiveExtractorMock() | binary-download/archive-extractor.state-mock.ts |`
  - Insert alphabetically by interface name
  - Files affected: `docs/PATTERNS.md`

## Testing Strategy

No tests for test infrastructure. The mock will be validated through usage in actual service tests.

Follows the State Mock Pattern documented in `docs/TESTING.md` (lines 359-483).

### Manual Testing Checklist

- [ ] Import mock in a test file and verify TypeScript types work
- [ ] Verify matchers appear in IDE autocomplete
- [ ] `pnpm validate:fix` passes

## Dependencies

No new dependencies required.

## Documentation Updates

### Files to Update

| File               | Changes Required                                              |
| ------------------ | ------------------------------------------------------------- |
| `docs/PATTERNS.md` | Add ArchiveExtractor to test utils location table (~line 933) |

### New Documentation Required

None - follows established patterns documented in `docs/TESTING.md`.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
