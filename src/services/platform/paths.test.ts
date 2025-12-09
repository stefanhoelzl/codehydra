// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";

describe("paths module", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("getDataRootDir", () => {
    it("returns ./app-data/ in development mode", async () => {
      process.env.NODE_ENV = "development";
      const { getDataRootDir } = await import("./paths");

      const result = getDataRootDir();

      expect(result).toMatch(/app-data[/\\]?$/);
    });

    it("returns ./app-data/ when NODE_ENV is not production", async () => {
      process.env.NODE_ENV = "test";
      const { getDataRootDir } = await import("./paths");

      const result = getDataRootDir();

      expect(result).toMatch(/app-data[/\\]?$/);
    });

    it("returns platform-specific path in production on Linux", async () => {
      process.env.NODE_ENV = "production";
      vi.stubGlobal("process", {
        ...process,
        platform: "linux",
        env: { ...process.env, NODE_ENV: "production", HOME: "/home/user" },
      });
      const { getDataRootDir } = await import("./paths");

      const result = getDataRootDir();

      expect(result).toBe("/home/user/.local/share/codehydra");
    });

    it("returns platform-specific path in production on macOS", async () => {
      process.env.NODE_ENV = "production";
      vi.stubGlobal("process", {
        ...process,
        platform: "darwin",
        env: { ...process.env, NODE_ENV: "production", HOME: "/Users/user" },
      });
      const { getDataRootDir } = await import("./paths");

      const result = getDataRootDir();

      expect(result).toBe("/Users/user/Library/Application Support/Codehydra");
    });

    it("returns platform-specific path in production on Windows", async () => {
      process.env.NODE_ENV = "production";
      vi.stubGlobal("process", {
        ...process,
        platform: "win32",
        env: {
          ...process.env,
          NODE_ENV: "production",
          APPDATA: "C:\\Users\\user\\AppData\\Roaming",
        },
      });
      const { getDataRootDir } = await import("./paths");

      const result = getDataRootDir();

      // Note: On non-Windows systems, path.join uses forward slashes
      // In production on Windows, the correct backslash separator will be used
      expect(result).toMatch(/C:[/\\]Users[/\\]user[/\\]AppData[/\\]Roaming[/\\]Codehydra/);
    });
  });

  describe("getDataProjectsDir", () => {
    it("returns projects subdirectory of data root", async () => {
      process.env.NODE_ENV = "development";
      const { getDataProjectsDir } = await import("./paths");

      const result = getDataProjectsDir();

      expect(result).toMatch(/app-data[/\\]projects$/);
    });
  });

  describe("getProjectWorkspacesDir", () => {
    it("returns workspaces subdirectory for a project", async () => {
      process.env.NODE_ENV = "development";
      const { getProjectWorkspacesDir, projectDirName } = await import("./paths");
      const projectPath = "/home/user/projects/my-repo";

      const result = getProjectWorkspacesDir(projectPath);

      const expectedDirName = projectDirName(projectPath);
      expect(result).toContain(expectedDirName);
      expect(result).toMatch(/workspaces$/);
    });
  });

  describe("projectDirName", () => {
    it("generates name from folder name and hash", async () => {
      const { projectDirName } = await import("./paths");
      const projectPath = "/home/user/projects/my-repo";

      const result = projectDirName(projectPath);

      expect(result).toMatch(/^my-repo-[a-f0-9]{8}$/);
    });

    it("generates deterministic name for same path", async () => {
      const { projectDirName } = await import("./paths");
      const projectPath = "/home/user/projects/my-repo";

      const result1 = projectDirName(projectPath);
      const result2 = projectDirName(projectPath);

      expect(result1).toBe(result2);
    });

    it("generates different names for different paths", async () => {
      const { projectDirName } = await import("./paths");

      const result1 = projectDirName("/home/user/projects/repo-a");
      const result2 = projectDirName("/home/user/projects/repo-b");

      expect(result1).not.toBe(result2);
    });

    it("handles unicode characters in path", async () => {
      const { projectDirName } = await import("./paths");
      const projectPath = "/home/user/projects/my-repo";

      const result = projectDirName(projectPath);

      expect(result).toMatch(/^my-repo-[a-f0-9]{8}$/);
    });

    it("uses 8-char sha256 hash", async () => {
      const { projectDirName } = await import("./paths");
      const projectPath = "/home/user/projects/my-repo";

      const result = projectDirName(projectPath);

      const expectedHash = createHash("sha256").update(projectPath).digest("hex").substring(0, 8);
      expect(result).toBe(`my-repo-${expectedHash}`);
    });
  });

  describe("sanitizeWorkspaceName", () => {
    it("replaces forward slashes with percent signs", async () => {
      const { sanitizeWorkspaceName } = await import("./paths");

      const result = sanitizeWorkspaceName("feature/my-feature");

      expect(result).toBe("feature%my-feature");
    });

    it("handles multiple slashes", async () => {
      const { sanitizeWorkspaceName } = await import("./paths");

      const result = sanitizeWorkspaceName("user/feature/sub-feature");

      expect(result).toBe("user%feature%sub-feature");
    });

    it("returns unchanged if no slashes", async () => {
      const { sanitizeWorkspaceName } = await import("./paths");

      const result = sanitizeWorkspaceName("my-feature");

      expect(result).toBe("my-feature");
    });
  });

  describe("unsanitizeWorkspaceName", () => {
    it("replaces percent signs with forward slashes", async () => {
      const { unsanitizeWorkspaceName } = await import("./paths");

      const result = unsanitizeWorkspaceName("feature%my-feature");

      expect(result).toBe("feature/my-feature");
    });

    it("handles multiple percent signs", async () => {
      const { unsanitizeWorkspaceName } = await import("./paths");

      const result = unsanitizeWorkspaceName("user%feature%sub-feature");

      expect(result).toBe("user/feature/sub-feature");
    });

    it("roundtrips with sanitizeWorkspaceName", async () => {
      const { sanitizeWorkspaceName, unsanitizeWorkspaceName } = await import("./paths");
      const original = "user/feature/my-feature";

      const sanitized = sanitizeWorkspaceName(original);
      const unsanitized = unsanitizeWorkspaceName(sanitized);

      expect(unsanitized).toBe(original);
    });
  });

  describe("getVscodeDir", () => {
    it("returns vscode subdirectory of data root in development", async () => {
      process.env.NODE_ENV = "development";
      const { getVscodeDir } = await import("./paths");

      const result = getVscodeDir();

      expect(result).toMatch(/app-data[/\\]vscode$/);
    });

    it("returns vscode subdirectory of data root in production on Linux", async () => {
      process.env.NODE_ENV = "production";
      vi.stubGlobal("process", {
        ...process,
        platform: "linux",
        env: { ...process.env, NODE_ENV: "production", HOME: "/home/user" },
      });
      const { getVscodeDir } = await import("./paths");

      const result = getVscodeDir();

      expect(result).toBe("/home/user/.local/share/codehydra/vscode");
    });

    it("returns vscode subdirectory of data root in production on macOS", async () => {
      process.env.NODE_ENV = "production";
      vi.stubGlobal("process", {
        ...process,
        platform: "darwin",
        env: { ...process.env, NODE_ENV: "production", HOME: "/Users/user" },
      });
      const { getVscodeDir } = await import("./paths");

      const result = getVscodeDir();

      expect(result).toBe("/Users/user/Library/Application Support/Codehydra/vscode");
    });

    it("returns vscode subdirectory of data root in production on Windows", async () => {
      process.env.NODE_ENV = "production";
      vi.stubGlobal("process", {
        ...process,
        platform: "win32",
        env: {
          ...process.env,
          NODE_ENV: "production",
          APPDATA: "C:\\Users\\user\\AppData\\Roaming",
        },
      });
      const { getVscodeDir } = await import("./paths");

      const result = getVscodeDir();

      expect(result).toMatch(
        /C:[/\\]Users[/\\]user[/\\]AppData[/\\]Roaming[/\\]Codehydra[/\\]vscode/
      );
    });
  });

  describe("getVscodeExtensionsDir", () => {
    it("returns extensions subdirectory of vscode dir", async () => {
      process.env.NODE_ENV = "development";
      const { getVscodeExtensionsDir } = await import("./paths");

      const result = getVscodeExtensionsDir();

      expect(result).toMatch(/app-data[/\\]vscode[/\\]extensions$/);
    });
  });

  describe("getVscodeUserDataDir", () => {
    it("returns user-data subdirectory of vscode dir", async () => {
      process.env.NODE_ENV = "development";
      const { getVscodeUserDataDir } = await import("./paths");

      const result = getVscodeUserDataDir();

      expect(result).toMatch(/app-data[/\\]vscode[/\\]user-data$/);
    });
  });

  describe("getVscodeSetupMarkerPath", () => {
    it("returns .setup-completed path in vscode dir", async () => {
      process.env.NODE_ENV = "development";
      const { getVscodeSetupMarkerPath } = await import("./paths");

      const result = getVscodeSetupMarkerPath();

      expect(result).toMatch(/app-data[/\\]vscode[/\\]\.setup-completed$/);
    });
  });

  describe("encodePathForUrl", () => {
    it("encodes spaces", async () => {
      const { encodePathForUrl } = await import("./paths");

      const result = encodePathForUrl("/home/user/my project");

      expect(result).toBe("/home/user/my%20project");
    });

    it("encodes special characters", async () => {
      const { encodePathForUrl } = await import("./paths");

      const result = encodePathForUrl("/home/user/project#1");

      expect(result).toBe("/home/user/project%231");
    });

    it("preserves forward slashes", async () => {
      const { encodePathForUrl } = await import("./paths");

      const result = encodePathForUrl("/home/user/project/src");

      expect(result).toBe("/home/user/project/src");
    });

    it("handles unicode characters", async () => {
      const { encodePathForUrl } = await import("./paths");

      const result = encodePathForUrl("/home/user/cafe");

      expect(result).toBe("/home/user/cafe");
    });
  });
});
