// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  directoryListing,
  directorySlashRedirect,
  localFileContentType,
  parseLocalFileUrl,
} from "./local-files";
import { createDirEntry } from "../../boundaries/platform/filesystem.state-mock";

const HOST = "https://file.codehydra.invalid";

describe("parseLocalFileUrl", () => {
  it("decodes the path and ignores query and hash", () => {
    expect(parseLocalFileUrl(`${HOST}/tmp/a%20b.html?id=1#x`, "linux")).toEqual({
      path: "/tmp/a b.html",
      trailingSlash: false,
      lastSegment: "a%20b.html",
    });
  });

  it("marks directory URLs", () => {
    expect(parseLocalFileUrl(`${HOST}/tmp/report/`, "darwin")).toMatchObject({
      path: "/tmp/report/",
      trailingSlash: true,
    });
  });

  it("lifts the drive out of a Windows URL path", () => {
    expect(parseLocalFileUrl(`${HOST}/C:/Users/u/r.html`, "win32")?.path).toBe("C:/Users/u/r.html");
    expect(parseLocalFileUrl(`${HOST}/D:`, "win32")?.path).toBe("D:/");
  });

  it("refuses a Windows URL path without a drive", () => {
    expect(parseLocalFileUrl(`${HOST}/Users/u/r.html`, "win32")).toBeNull();
  });

  it("is null for every other URL", () => {
    expect(parseLocalFileUrl("https://example.com/tmp/a.html", "linux")).toBeNull();
    expect(parseLocalFileUrl("http://file.codehydra.invalid/tmp/a.html", "linux")).toBeNull();
    expect(parseLocalFileUrl("https://x.file.codehydra.invalid/a", "linux")).toBeNull();
    expect(parseLocalFileUrl(`${HOST}/bad%E0%A4%A`, "linux")).toBeNull();
    expect(parseLocalFileUrl("not a url", "linux")).toBeNull();
  });
});

describe("localFileContentType", () => {
  it("adds a utf-8 charset to text", () => {
    expect(localFileContentType("/a/index.html")).toBe("text/html; charset=utf-8");
    expect(localFileContentType("/a/data.json")).toBe("application/json; charset=utf-8");
  });

  it("leaves binary types alone and defaults unknown ones to octet-stream", () => {
    expect(localFileContentType("/a/x.wasm")).toBe("application/wasm");
    expect(localFileContentType("/a/x")).toBe("application/octet-stream");
  });
});

describe("directoryListing", () => {
  it("escapes names", () => {
    const html = directoryListing("/d", [createDirEntry('<x">', { isFile: true })]);

    expect(html).toContain('<a href="%3Cx%22%3E">&lt;x&quot;&gt;</a>');
  });

  it("offers a parent link everywhere but a root", () => {
    expect(directoryListing("/d", [])).toContain('href="../"');
    expect(directoryListing("/", [])).not.toContain('href="../"');
    expect(directoryListing("C:/", [])).not.toContain('href="../"');
  });
});

describe("directorySlashRedirect", () => {
  it("refreshes to the same directory with a trailing slash", () => {
    expect(directorySlashRedirect("my%20dir")).toContain('content="0;url=my%20dir/"');
  });
});
