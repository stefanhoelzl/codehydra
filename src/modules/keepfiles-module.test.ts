// @vitest-environment node
/**
 * Unit tests for KeepFilesService (inlined into keepfiles module).
 * Uses mocked FileSystemBoundary to test the service logic.
 */

import { describe, it, expect } from "vitest";
import { KeepFilesService } from "./keepfiles-module";
import {
  createFileSystemMock,
  createSpyFileSystemBoundary,
  file,
  directory,
  symlink,
} from "../boundaries/platform/filesystem.state-mock";
import { FileSystemError } from "../shared/errors/service-errors";
import { SILENT_LOGGER } from "../boundaries/platform/logging";
import { Path } from "../utils/path/path";

describe("KeepFilesService", () => {
  describe("copyToWorkspace", () => {
    describe("no .keepfiles config", () => {
      it("copies nothing when no .keepfiles", async () => {
        // Empty filesystem - .keepfiles doesn't exist
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(0);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe("empty .keepfiles config", () => {
      it("copies nothing when .keepfiles is empty", async () => {
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file(""),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(0);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe("comments and blank lines", () => {
      it("ignores comments and blank lines", async () => {
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file("# This is a comment\n\n# Another comment\n"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(0);
      });

      it("ignores whitespace-only lines", async () => {
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file("  \n\t\n   \t   \n"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(0);
      });
    });

    describe("single file pattern", () => {
      it("matches and copies single file", async () => {
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file(".env"),
            "/project/.env": file("ENV_VAR=value"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(1);
        // Verify the file was copied
        expect(mockFs).toHaveFile("/workspace/.env", "ENV_VAR=value");
      });
    });

    describe("directory pattern", () => {
      it("copies entire directory tree by scanning files", async () => {
        const mockFs = createSpyFileSystemBoundary({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file(".vscode/"),
            "/project/.vscode": directory(),
            "/project/.vscode/settings.json": file("{}"),
            "/project/.vscode/extensions.json": file("[]"),
            "/project/.vscode/subdir": directory(),
            "/project/.vscode/subdir/config.json": file("{}"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        // Each file is copied individually (3 files total)
        expect(result.copiedCount).toBe(3);
        expect(mockFs.copyTree).toHaveBeenCalledTimes(3);
        expect(mockFs).toHaveFile("/workspace/.vscode/settings.json", "{}");
        expect(mockFs).toHaveFile("/workspace/.vscode/extensions.json", "[]");
        expect(mockFs).toHaveFile("/workspace/.vscode/subdir/config.json", "{}");
      });
    });

    describe("glob patterns", () => {
      it("matches glob pattern .env.*", async () => {
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file(".env.*"),
            "/project/.env.local": file("LOCAL=true"),
            "/project/.env.development": file("DEV=true"),
            "/project/README.md": file("# Readme"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(2); // .env.local and .env.development
        // Verify the right files were copied
        expect(mockFs).toHaveFile("/workspace/.env.local", "LOCAL=true");
        expect(mockFs).toHaveFile("/workspace/.env.development", "DEV=true");
        expect(mockFs).not.toHaveFile("/workspace/README.md");
      });
    });

    describe("negation", () => {
      it("excludes files with negation pattern", async () => {
        const mockFs = createSpyFileSystemBoundary({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file("secrets/*\n!secrets/README.md"),
            "/project/secrets": directory(),
            "/project/secrets/api-key.txt": file("key"),
            "/project/secrets/README.md": file("# secrets"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(1);
        expect(mockFs.copyTree).toHaveBeenCalledTimes(1);
        expect(mockFs).toHaveFile("/workspace/secrets/api-key.txt", "key");
        expect(mockFs).not.toHaveFile("/workspace/secrets/README.md");
      });
    });

    describe("error handling", () => {
      it("collects copy errors without stopping other copies", async () => {
        const mockFs = createSpyFileSystemBoundary({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file(".env\n.env.local"),
            "/project/.env": file("ENV=value"),
            "/project/.env.local": file("LOCAL=value"),
            "/workspace": directory(),
          },
        });
        // First copy (.env) fails; the second falls through to the mock and succeeds.
        mockFs.copyTree.mockRejectedValueOnce(
          new FileSystemError("EACCES", "/project/.env", "Permission denied")
        );
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.path).toBe(".env");
        expect(result.errors[0]?.message).toContain("Permission denied");
        expect(mockFs).toHaveFile("/workspace/.env.local", "LOCAL=value");
      });
    });

    describe("security - path traversal", () => {
      it("detects path traversal in destination and adds to errors", async () => {
        const mockFs = createSpyFileSystemBoundary({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file("normal.txt"),
            "/workspace": directory(),
          },
        });
        // A virtual tree cannot contain a "../" name, so simulate a hostile
        // filesystem by overriding readdir.
        mockFs.readdir.mockResolvedValue([
          { name: "../escape.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
        ]);
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(
          result.errors.some((e: { message: string }) => e.message.includes("traversal"))
        ).toBe(true);
      });
    });

    describe("symlink handling", () => {
      it("skips symlinks", async () => {
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file("link.txt\nfile.txt"),
            "/project/link.txt": symlink("/somewhere/else"),
            "/project/file.txt": file("content"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(1);
        expect(mockFs).toHaveFile("/workspace/file.txt", "content");
        expect(mockFs).not.toHaveFile("/workspace/link.txt");
      });
    });

    describe("UTF-8 BOM handling", () => {
      it("handles .keepfiles with UTF-8 BOM correctly", async () => {
        const mockFs = createFileSystemMock({
          entries: {
            "/project": directory(),
            "/project/.keepfiles": file("\ufeff.env\n.env.local"),
            "/project/.env": file("ENV=value"),
            "/project/.env.local": file("LOCAL=value"),
            "/workspace": directory(),
          },
        });
        const service = new KeepFilesService(mockFs, SILENT_LOGGER);

        const result = await service.copyToWorkspace(new Path("/project"), new Path("/workspace"));

        expect(result.copiedCount).toBe(2);
        expect(mockFs).toHaveFile("/workspace/.env", "ENV=value");
        expect(mockFs).toHaveFile("/workspace/.env.local", "LOCAL=value");
      });
    });
  });
});
