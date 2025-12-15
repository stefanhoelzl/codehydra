// @vitest-environment node
/**
 * Boundary tests for KeepFilesService.
 * Tests with real filesystem and real ignore package.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFile as nodeWriteFile, mkdir as nodeMkdir } from "node:fs/promises";
import { KeepFilesService } from "./keepfiles-service";
import { DefaultFileSystemLayer } from "../platform/filesystem";
import { createTempDir } from "../test-utils";

describe("KeepFilesService", () => {
  let tempDir: { path: string; cleanup: () => Promise<void> };
  let projectRoot: string;
  let targetPath: string;
  let fs: DefaultFileSystemLayer;
  let service: KeepFilesService;

  beforeEach(async () => {
    tempDir = await createTempDir();
    projectRoot = join(tempDir.path, "project");
    targetPath = join(tempDir.path, "workspace");
    await nodeMkdir(projectRoot);
    await nodeMkdir(targetPath);
    fs = new DefaultFileSystemLayer();
    service = new KeepFilesService(fs);
  });

  afterEach(async () => {
    await tempDir.cleanup();
  });

  describe("real .keepfiles file parsing", () => {
    it("parses .keepfiles and copies matching files", async () => {
      // Create .keepfiles
      await nodeWriteFile(join(projectRoot, ".keepfiles"), ".env\n.env.local\n", "utf-8");

      // Create matching files
      await nodeWriteFile(join(projectRoot, ".env"), "SECRET=value", "utf-8");
      await nodeWriteFile(join(projectRoot, ".env.local"), "LOCAL=true", "utf-8");
      await nodeWriteFile(join(projectRoot, "README.md"), "not matched", "utf-8");

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.configExists).toBe(true);
      expect(result.copiedCount).toBe(2);

      // Verify files copied
      const envContent = await fs.readFile(join(targetPath, ".env"));
      expect(envContent).toBe("SECRET=value");
      const localContent = await fs.readFile(join(targetPath, ".env.local"));
      expect(localContent).toBe("LOCAL=true");

      // Verify non-matching file not copied
      await expect(fs.readFile(join(targetPath, "README.md"))).rejects.toThrow();
    });
  });

  describe("glob patterns with ignore package", () => {
    it("matches .env.* glob pattern", async () => {
      await nodeWriteFile(join(projectRoot, ".keepfiles"), ".env.*\n", "utf-8");

      await nodeWriteFile(join(projectRoot, ".env.local"), "local", "utf-8");
      await nodeWriteFile(join(projectRoot, ".env.development"), "dev", "utf-8");
      await nodeWriteFile(join(projectRoot, ".env.production"), "prod", "utf-8");
      await nodeWriteFile(join(projectRoot, ".env"), "base", "utf-8"); // Should NOT match

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.copiedCount).toBe(3);

      // Verify matched files
      expect(await fs.readFile(join(targetPath, ".env.local"))).toBe("local");
      expect(await fs.readFile(join(targetPath, ".env.development"))).toBe("dev");
      expect(await fs.readFile(join(targetPath, ".env.production"))).toBe("prod");

      // Base .env should NOT be copied (doesn't match .env.*)
      await expect(fs.readFile(join(targetPath, ".env"))).rejects.toThrow();
    });

    it("matches **/*.env recursive glob", async () => {
      await nodeWriteFile(join(projectRoot, ".keepfiles"), "**/*.env\n", "utf-8");

      await nodeMkdir(join(projectRoot, "config"));
      await nodeMkdir(join(projectRoot, "config", "nested"));
      await nodeWriteFile(join(projectRoot, "config", "app.env"), "app", "utf-8");
      await nodeWriteFile(join(projectRoot, "config", "nested", "deep.env"), "deep", "utf-8");
      await nodeWriteFile(join(projectRoot, "config", "other.txt"), "other", "utf-8");

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.copiedCount).toBe(2);

      expect(await fs.readFile(join(targetPath, "config", "app.env"))).toBe("app");
      expect(await fs.readFile(join(targetPath, "config", "nested", "deep.env"))).toBe("deep");
    });
  });

  describe("negation patterns", () => {
    it("excludes files with negation syntax", async () => {
      // Use dir/* to allow negation to work (gitignore limitation)
      await nodeWriteFile(
        join(projectRoot, ".keepfiles"),
        "secrets/*\n!secrets/README.md\n",
        "utf-8"
      );

      await nodeMkdir(join(projectRoot, "secrets"));
      await nodeWriteFile(join(projectRoot, "secrets", "api-key.txt"), "secret-key", "utf-8");
      await nodeWriteFile(join(projectRoot, "secrets", "password.txt"), "secret-pass", "utf-8");
      await nodeWriteFile(join(projectRoot, "secrets", "README.md"), "docs", "utf-8");

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.copiedCount).toBe(2); // api-key.txt and password.txt
      expect(result.skippedCount).toBe(1); // README.md

      expect(await fs.readFile(join(targetPath, "secrets", "api-key.txt"))).toBe("secret-key");
      expect(await fs.readFile(join(targetPath, "secrets", "password.txt"))).toBe("secret-pass");
      // README.md should NOT be copied
      await expect(fs.readFile(join(targetPath, "secrets", "README.md"))).rejects.toThrow();
    });
  });

  describe("trailing slash handling", () => {
    it("handles secrets/ pattern (directory)", async () => {
      await nodeWriteFile(join(projectRoot, ".keepfiles"), "config/\n", "utf-8");

      await nodeMkdir(join(projectRoot, "config"));
      await nodeWriteFile(join(projectRoot, "config", "app.json"), '{"key": "value"}', "utf-8");
      await nodeWriteFile(join(projectRoot, "config", "db.json"), '{"db": "postgres"}', "utf-8");

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.copiedCount).toBe(2);
      expect(await fs.readFile(join(targetPath, "config", "app.json"))).toBe('{"key": "value"}');
    });

    it("handles secrets pattern (without trailing slash)", async () => {
      await nodeWriteFile(join(projectRoot, ".keepfiles"), "config\n", "utf-8");

      await nodeMkdir(join(projectRoot, "config"));
      await nodeWriteFile(join(projectRoot, "config", "app.json"), '{"key": "value"}', "utf-8");

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      // Pattern without trailing slash matches files and directories
      expect(result.copiedCount).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("handles empty .keepfiles", async () => {
      await nodeWriteFile(join(projectRoot, ".keepfiles"), "", "utf-8");

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.configExists).toBe(true);
      expect(result.copiedCount).toBe(0);
    });

    it("handles .keepfiles with only comments", async () => {
      await nodeWriteFile(
        join(projectRoot, ".keepfiles"),
        "# Comment line\n# Another comment\n",
        "utf-8"
      );

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.configExists).toBe(true);
      expect(result.copiedCount).toBe(0);
    });

    it("handles no .keepfiles", async () => {
      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.configExists).toBe(false);
      expect(result.copiedCount).toBe(0);
    });

    it("handles .keepfiles with UTF-8 BOM", async () => {
      // Write with BOM
      const content = "\ufeff.env\n";
      await nodeWriteFile(join(projectRoot, ".keepfiles"), content, "utf-8");
      await nodeWriteFile(join(projectRoot, ".env"), "value", "utf-8");

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.copiedCount).toBe(1);
    });

    it("copies deeply nested directory structure", async () => {
      await nodeWriteFile(join(projectRoot, ".keepfiles"), "deep/\n", "utf-8");

      await nodeMkdir(join(projectRoot, "deep", "level1", "level2", "level3"), { recursive: true });
      await nodeWriteFile(join(projectRoot, "deep", "root.txt"), "root", "utf-8");
      await nodeWriteFile(join(projectRoot, "deep", "level1", "l1.txt"), "l1", "utf-8");
      await nodeWriteFile(join(projectRoot, "deep", "level1", "level2", "l2.txt"), "l2", "utf-8");
      await nodeWriteFile(
        join(projectRoot, "deep", "level1", "level2", "level3", "l3.txt"),
        "l3",
        "utf-8"
      );

      const result = await service.copyToWorkspace(projectRoot, targetPath);

      expect(result.copiedCount).toBe(4);
      expect(
        await fs.readFile(join(targetPath, "deep", "level1", "level2", "level3", "l3.txt"))
      ).toBe("l3");
    });
  });
});
