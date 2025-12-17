/**
 * Unit tests for ArchiveExtractor implementations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DefaultArchiveExtractor, TarExtractor, ZipExtractor } from "./archive-extractor";
import { ArchiveError } from "./errors";
import { createMockArchiveExtractor } from "./archive-extractor.test-utils";

// Mock the tar and yauzl modules
vi.mock("tar", () => ({
  extract: vi.fn(),
}));

vi.mock("yauzl", () => ({
  default: {
    open: vi.fn(),
  },
}));

// Mock fs module
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    },
    createWriteStream: vi.fn(),
  };
});

describe("TarExtractor", () => {
  let tarMock: { extract: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const tar = await import("tar");
    tarMock = tar as unknown as { extract: ReturnType<typeof vi.fn> };
    tarMock.extract.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls tar.extract with correct options", async () => {
    tarMock.extract.mockResolvedValue(undefined);
    const extractor = new TarExtractor();

    await extractor.extract("/path/to/archive.tar.gz", "/dest/dir");

    expect(tarMock.extract).toHaveBeenCalledWith({
      file: "/path/to/archive.tar.gz",
      cwd: "/dest/dir",
    });
  });

  it("throws ArchiveError with INVALID_ARCHIVE for corrupt archives", async () => {
    tarMock.extract.mockRejectedValue(new Error("TAR_BAD_ARCHIVE: Invalid tar data"));
    const extractor = new TarExtractor();

    await expect(extractor.extract("/path/to/bad.tar.gz", "/dest")).rejects.toThrow(ArchiveError);
    await expect(extractor.extract("/path/to/bad.tar.gz", "/dest")).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
    });
  });

  it("throws ArchiveError with INVALID_ARCHIVE for zlib errors", async () => {
    tarMock.extract.mockRejectedValue(new Error("zlib: invalid deflate data"));
    const extractor = new TarExtractor();

    await expect(extractor.extract("/path/to/bad.tar.gz", "/dest")).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
    });
  });

  it("throws ArchiveError with PERMISSION_DENIED for EACCES errors", async () => {
    tarMock.extract.mockRejectedValue(new Error("EACCES: permission denied"));
    const extractor = new TarExtractor();

    await expect(extractor.extract("/path/to/archive.tar.gz", "/dest")).rejects.toMatchObject({
      errorCode: "PERMISSION_DENIED",
    });
  });

  it("throws ArchiveError with EXTRACTION_FAILED for other errors", async () => {
    tarMock.extract.mockRejectedValue(new Error("Some other error"));
    const extractor = new TarExtractor();

    await expect(extractor.extract("/path/to/archive.tar.gz", "/dest")).rejects.toMatchObject({
      errorCode: "EXTRACTION_FAILED",
    });
  });
});

describe("ZipExtractor", () => {
  let yauzlMock: { default: { open: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    const yauzl = await import("yauzl");
    yauzlMock = yauzl as unknown as { default: { open: ReturnType<typeof vi.fn> } };
    yauzlMock.default.open.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws ArchiveError with INVALID_ARCHIVE for corrupt zip files", async () => {
    yauzlMock.default.open.mockImplementation((_path, _opts, callback) => {
      callback(new Error("end of central directory record signature not found"), null);
    });
    const extractor = new ZipExtractor();

    await expect(extractor.extract("/path/to/bad.zip", "/dest")).rejects.toThrow(ArchiveError);
    await expect(extractor.extract("/path/to/bad.zip", "/dest")).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
    });
  });

  it("throws ArchiveError with EXTRACTION_FAILED for open errors", async () => {
    yauzlMock.default.open.mockImplementation((_path, _opts, callback) => {
      callback(new Error("ENOENT: no such file"), null);
    });
    const extractor = new ZipExtractor();

    await expect(extractor.extract("/path/to/missing.zip", "/dest")).rejects.toMatchObject({
      errorCode: "EXTRACTION_FAILED",
    });
  });
});

describe("DefaultArchiveExtractor", () => {
  it("selects TarExtractor for .tar.gz files", async () => {
    const extractor = new DefaultArchiveExtractor();
    const tarMock = (await import("tar")) as unknown as { extract: ReturnType<typeof vi.fn> };
    tarMock.extract.mockResolvedValue(undefined);

    await extractor.extract("/path/to/archive.tar.gz", "/dest");

    expect(tarMock.extract).toHaveBeenCalled();
  });

  it("selects TarExtractor for .tgz files", async () => {
    const extractor = new DefaultArchiveExtractor();
    const tarMock = (await import("tar")) as unknown as { extract: ReturnType<typeof vi.fn> };
    tarMock.extract.mockResolvedValue(undefined);

    await extractor.extract("/path/to/archive.tgz", "/dest");

    expect(tarMock.extract).toHaveBeenCalled();
  });

  it("selects ZipExtractor for .zip files", async () => {
    const extractor = new DefaultArchiveExtractor();
    const yauzlMock = (await import("yauzl")) as unknown as {
      default: { open: ReturnType<typeof vi.fn> };
    };

    // Mock a successful zip extraction with no entries
    yauzlMock.default.open.mockImplementation((_path, _opts, callback) => {
      const mockZipfile = {
        readEntry: vi.fn(),
        on: vi.fn((event: string, handler: () => void) => {
          if (event === "end") {
            // Defer to allow on() to complete
            setTimeout(handler, 0);
          }
          return mockZipfile;
        }),
      };
      callback(null, mockZipfile);
    });

    await extractor.extract("/path/to/archive.zip", "/dest");

    expect(yauzlMock.default.open).toHaveBeenCalled();
  });

  it("is case-insensitive for extensions", async () => {
    const extractor = new DefaultArchiveExtractor();
    const tarMock = (await import("tar")) as unknown as { extract: ReturnType<typeof vi.fn> };
    tarMock.extract.mockResolvedValue(undefined);

    await extractor.extract("/path/to/ARCHIVE.TAR.GZ", "/dest");

    expect(tarMock.extract).toHaveBeenCalled();
  });

  it("throws ArchiveError with INVALID_ARCHIVE for unsupported formats", async () => {
    const extractor = new DefaultArchiveExtractor();

    await expect(extractor.extract("/path/to/archive.rar", "/dest")).rejects.toThrow(ArchiveError);
    await expect(extractor.extract("/path/to/archive.rar", "/dest")).rejects.toMatchObject({
      errorCode: "INVALID_ARCHIVE",
      message: expect.stringContaining("Unsupported archive format"),
    });
  });
});

describe("createMockArchiveExtractor", () => {
  it("creates a mock that succeeds by default", async () => {
    const mock = createMockArchiveExtractor();

    await expect(mock.extract("/archive.tar.gz", "/dest")).resolves.toBeUndefined();
    expect(mock.extract).toHaveBeenCalledWith("/archive.tar.gz", "/dest");
  });

  it("creates a mock that throws when error is configured", async () => {
    const mock = createMockArchiveExtractor({
      error: { message: "Test error", code: "EXTRACTION_FAILED" },
    });

    await expect(mock.extract("/archive.tar.gz", "/dest")).rejects.toThrow(ArchiveError);
    await expect(mock.extract("/archive.tar.gz", "/dest")).rejects.toMatchObject({
      errorCode: "EXTRACTION_FAILED",
    });
  });
});
