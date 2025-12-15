// @vitest-environment node
/**
 * Unit tests for KeepFilesService.
 * Uses mocked FileSystemLayer to test the service logic.
 */

import { describe, it, expect, vi } from "vitest";
import { KeepFilesService } from "./keepfiles-service";
import { createMockFileSystemLayer, createDirEntry } from "../platform/filesystem.test-utils";
import { FileSystemError, KeepFilesError } from "../errors";
import type { FileSystemLayer } from "../platform/filesystem";

describe("KeepFilesService", () => {
  describe("copyToWorkspace", () => {
    describe("no .keepfiles config", () => {
      it("returns configExists: false when no .keepfiles", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: {
            error: new FileSystemError("ENOENT", "/project/.keepfiles", "Not found"),
          },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.configExists).toBe(false);
        expect(result.copiedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe("empty .keepfiles config", () => {
      it("returns configExists: true with copiedCount: 0 when .keepfiles is empty", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: "" },
          readdir: { entries: [] },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.configExists).toBe(true);
        expect(result.copiedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe("comments and blank lines", () => {
      it("ignores comments and blank lines", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: "# This is a comment\n\n# Another comment\n" },
          readdir: { entries: [] },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.configExists).toBe(true);
        expect(result.copiedCount).toBe(0);
      });

      it("ignores whitespace-only lines", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: "  \n\t\n   \t   \n" },
          readdir: { entries: [] },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.configExists).toBe(true);
        expect(result.copiedCount).toBe(0);
      });
    });

    describe("single file pattern", () => {
      it("matches and copies single file", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: ".env" },
          readdir: {
            entries: [createDirEntry(".env", { isFile: true })],
          },
          copyTree: { result: { copiedCount: 1, skippedSymlinks: [] } },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.configExists).toBe(true);
        expect(result.copiedCount).toBe(1);
      });
    });

    describe("directory pattern", () => {
      it("copies entire directory tree by scanning files", async () => {
        // When a directory pattern matches, the implementation scans into the directory
        // and copies matching files individually (to support negation patterns)
        const readFileFn = vi.fn().mockResolvedValue(".vscode/");
        const readdirFn = vi.fn().mockImplementation((path: string) => {
          if (path === "/project") {
            return Promise.resolve([createDirEntry(".vscode", { isDirectory: true })]);
          }
          if (path === "/project/.vscode") {
            return Promise.resolve([
              createDirEntry("settings.json", { isFile: true }),
              createDirEntry("extensions.json", { isFile: true }),
              createDirEntry("subdir", { isDirectory: true }),
            ]);
          }
          if (path === "/project/.vscode/subdir") {
            return Promise.resolve([createDirEntry("config.json", { isFile: true })]);
          }
          return Promise.resolve([]);
        });
        const copyTreeFn = vi.fn().mockResolvedValue({ copiedCount: 1, skippedSymlinks: [] });

        const mockFs: FileSystemLayer = {
          readFile: readFileFn,
          readdir: readdirFn,
          copyTree: copyTreeFn,
          writeFile: vi.fn(),
          mkdir: vi.fn(),
          unlink: vi.fn(),
          rm: vi.fn(),
        };
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        // Each file is copied individually (3 files total)
        expect(result.copiedCount).toBe(3);
        expect(copyTreeFn).toHaveBeenCalledTimes(3);
      });
    });

    describe("glob patterns", () => {
      it("matches glob pattern .env.*", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: ".env.*" },
          readdir: {
            entries: [
              createDirEntry(".env.local", { isFile: true }),
              createDirEntry(".env.development", { isFile: true }),
              createDirEntry("README.md", { isFile: true }),
            ],
          },
          copyTree: { result: { copiedCount: 1, skippedSymlinks: [] } },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.copiedCount).toBe(2); // .env.local and .env.development
      });
    });

    describe("negation", () => {
      it("excludes files with negation pattern", async () => {
        // Note: For negation to work with files inside a directory, use "dir/*" or "dir/**"
        // pattern instead of "dir/". This is a gitignore limitation - you can't re-include
        // a file if a parent directory is excluded.
        const readdirFn = vi.fn().mockImplementation((path: string) => {
          if (path === "/project") {
            return Promise.resolve([createDirEntry("secrets", { isDirectory: true })]);
          }
          if (path === "/project/secrets") {
            return Promise.resolve([
              createDirEntry("api-key.txt", { isFile: true }),
              createDirEntry("README.md", { isFile: true }),
            ]);
          }
          return Promise.resolve([]);
        });
        const copyTreeFn = vi.fn().mockResolvedValue({ copiedCount: 1, skippedSymlinks: [] });

        const mockFs: FileSystemLayer = {
          // Use secrets/* to match files inside secrets/, allowing negation to work
          readFile: vi.fn().mockResolvedValue("secrets/*\n!secrets/README.md"),
          readdir: readdirFn,
          copyTree: copyTreeFn,
          writeFile: vi.fn(),
          mkdir: vi.fn(),
          unlink: vi.fn(),
          rm: vi.fn(),
        };
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        // Should copy secrets/api-key.txt but NOT secrets/README.md
        expect(result.copiedCount).toBe(1);
        expect(result.skippedCount).toBe(1); // README.md was skipped due to negation
      });
    });

    describe("error handling", () => {
      it("collects copy errors without stopping other copies", async () => {
        const readFileFn = vi.fn().mockResolvedValue(".env\n.env.local");
        const readdirFn = vi
          .fn()
          .mockResolvedValue([
            createDirEntry(".env", { isFile: true }),
            createDirEntry(".env.local", { isFile: true }),
          ]);
        const copyTreeFn = vi
          .fn()
          .mockRejectedValueOnce(
            new FileSystemError("EACCES", "/project/.env", "Permission denied")
          )
          .mockResolvedValueOnce({ copiedCount: 1, skippedSymlinks: [] });

        const mockFs: FileSystemLayer = {
          readFile: readFileFn,
          readdir: readdirFn,
          copyTree: copyTreeFn,
          writeFile: vi.fn(),
          mkdir: vi.fn(),
          unlink: vi.fn(),
          rm: vi.fn(),
        };
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.copiedCount).toBe(1); // .env.local succeeded
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.path).toBe(".env");
        expect(result.errors[0]?.message).toContain("Permission denied");
      });
    });

    describe("security - pattern validation", () => {
      it("rejects absolute paths in patterns", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: "/etc/passwd" },
        });
        const service = new KeepFilesService(mockFs);

        await expect(service.copyToWorkspace("/project", "/workspace")).rejects.toThrow(
          KeepFilesError
        );
      });

      it("rejects parent references in patterns", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: "../other-project/.env" },
        });
        const service = new KeepFilesService(mockFs);

        await expect(service.copyToWorkspace("/project", "/workspace")).rejects.toThrow(
          KeepFilesError
        );
      });
    });

    describe("security - path traversal", () => {
      it("detects path traversal in destination and adds to errors", async () => {
        // Simulate a file that when joined with destination would escape
        // This is a contrived test - in practice path.join normalizes
        const readFileFn = vi.fn().mockResolvedValue("normal.txt");
        const readdirFn = vi.fn().mockResolvedValue([
          // Entry name with embedded path traversal (shouldn't happen from real fs)
          { name: "../escape.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
        ]);

        const mockFs: FileSystemLayer = {
          readFile: readFileFn,
          readdir: readdirFn,
          copyTree: vi.fn().mockResolvedValue({ copiedCount: 1, skippedSymlinks: [] }),
          writeFile: vi.fn(),
          mkdir: vi.fn(),
          unlink: vi.fn(),
          rm: vi.fn(),
        };
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        // Path traversal should be detected and rejected
        expect(
          result.errors.some((e: { message: string }) => e.message.includes("traversal"))
        ).toBe(true);
      });
    });

    describe("symlink handling", () => {
      it("skips symlinks and counts them in skippedCount", async () => {
        const mockFs = createMockFileSystemLayer({
          readFile: { content: "link.txt\nfile.txt" },
          readdir: {
            entries: [
              createDirEntry("link.txt", { isSymbolicLink: true }),
              createDirEntry("file.txt", { isFile: true }),
            ],
          },
          copyTree: { result: { copiedCount: 1, skippedSymlinks: [] } },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.copiedCount).toBe(1); // Only file.txt
        expect(result.skippedCount).toBe(1); // link.txt was skipped
      });
    });

    describe("UTF-8 BOM handling", () => {
      it("handles .keepfiles with UTF-8 BOM correctly", async () => {
        // UTF-8 BOM: \ufeff
        const mockFs = createMockFileSystemLayer({
          readFile: { content: "\ufeff.env\n.env.local" },
          readdir: {
            entries: [
              createDirEntry(".env", { isFile: true }),
              createDirEntry(".env.local", { isFile: true }),
            ],
          },
          copyTree: { result: { copiedCount: 1, skippedSymlinks: [] } },
        });
        const service = new KeepFilesService(mockFs);

        const result = await service.copyToWorkspace("/project", "/workspace");

        expect(result.copiedCount).toBe(2);
      });
    });
  });
});
