/**
 * Tests for binary download error types.
 */

import { describe, it, expect } from "vitest";
import { BinaryDownloadError, ArchiveError } from "./errors";
import { ServiceError } from "../errors";

describe("BinaryDownloadError", () => {
  it("extends ServiceError", () => {
    const error = new BinaryDownloadError("Download failed", "NETWORK_ERROR");

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toBeInstanceOf(BinaryDownloadError);
  });

  it("has correct type", () => {
    const error = new BinaryDownloadError("Download failed", "NETWORK_ERROR");

    expect(error.type).toBe("binary-download");
  });

  it("has correct error code", () => {
    const error = new BinaryDownloadError("Download failed", "NETWORK_ERROR");

    expect(error.errorCode).toBe("NETWORK_ERROR");
    expect(error.code).toBe("NETWORK_ERROR");
  });

  it("serializes correctly", () => {
    const error = new BinaryDownloadError("Download failed", "NETWORK_ERROR");

    const serialized = error.toJSON();

    expect(serialized).toEqual({
      type: "binary-download",
      message: "Download failed",
      code: "NETWORK_ERROR",
    });
  });

  it("supports all error codes", () => {
    const codes = [
      "NETWORK_ERROR",
      "EXTRACTION_FAILED",
      "UNSUPPORTED_PLATFORM",
      "INVALID_VERSION",
    ] as const;

    for (const code of codes) {
      const error = new BinaryDownloadError(`Error: ${code}`, code);
      expect(error.errorCode).toBe(code);
    }
  });
});

describe("ArchiveError", () => {
  it("extends ServiceError", () => {
    const error = new ArchiveError("Extraction failed", "EXTRACTION_FAILED");

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toBeInstanceOf(ArchiveError);
  });

  it("has correct type", () => {
    const error = new ArchiveError("Extraction failed", "EXTRACTION_FAILED");

    expect(error.type).toBe("archive");
  });

  it("has correct error code", () => {
    const error = new ArchiveError("Extraction failed", "EXTRACTION_FAILED");

    expect(error.errorCode).toBe("EXTRACTION_FAILED");
    expect(error.code).toBe("EXTRACTION_FAILED");
  });

  it("serializes correctly", () => {
    const error = new ArchiveError("Extraction failed", "EXTRACTION_FAILED");

    const serialized = error.toJSON();

    expect(serialized).toEqual({
      type: "archive",
      message: "Extraction failed",
      code: "EXTRACTION_FAILED",
    });
  });

  it("supports all error codes", () => {
    const codes = ["INVALID_ARCHIVE", "EXTRACTION_FAILED", "PERMISSION_DENIED"] as const;

    for (const code of codes) {
      const error = new ArchiveError(`Error: ${code}`, code);
      expect(error.errorCode).toBe(code);
    }
  });
});
