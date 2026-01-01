/**
 * Build script for VS Code extensions.
 *
 * This script:
 * 1. Discovers all extension folders in extensions/
 * 2. Builds and packages each extension as a .vsix file
 * 3. Downloads external extensions from VS Code Marketplace
 * 4. Generates dist/extensions/manifest.json with the complete extension manifest
 *
 * Version injection:
 * - Extensions have "version": "1.0.0-placeholder" in package.json (placeholder with major version prefix)
 * - Version is injected at build time: {major}.{commits}.0[-dev.{hash}]
 * - Release builds (VERSION env set): 1.47.0
 * - Dev builds: 1.47.0-dev.a1b2c3d4
 *
 * Usage: npm run build:extensions
 *        npx tsx scripts/build-extensions.ts
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const EXTENSIONS_DIR = path.join(process.cwd(), "extensions");
const DIST_DIR = path.join(process.cwd(), "dist", "extensions");
const EXTERNAL_JSON = path.join(EXTENSIONS_DIR, "external.json");

interface ExtensionPackageJson {
  publisher: string;
  name: string;
  version: string;
}

interface BundledExtension {
  id: string;
  version: string;
  vsix: string;
}

interface ExternalExtension {
  id: string;
  version: string;
}

/**
 * Hash an extension folder for dev version tagging.
 * Excludes node_modules and dist directories.
 * Returns first 8 hex chars of SHA-256 hash.
 */
async function hashExtensionFolder(extDir: string): Promise<string> {
  const hash = createHash("sha256");
  async function processDir(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await processDir(fullPath);
      else if (entry.isFile()) {
        hash.update(fullPath.slice(extDir.length));
        hash.update(await fsp.readFile(fullPath));
      }
    }
  }
  await processDir(extDir);
  return hash.digest("hex").slice(0, 8);
}

/**
 * Get the number of commits that have touched an extension directory.
 * Will fail if git unavailable - intentional to catch dev env issues.
 *
 * Note: If an extension directory is renamed, bump the major version in
 * package.json to account for the lost commit history.
 */
function getCommitCount(extDir: string): string {
  return execSync(`git rev-list --count HEAD -- "${extDir}"`, {
    encoding: "utf-8",
  }).trim();
}

/**
 * Get the extension version based on package.json major and git history.
 *
 * @param extDir - Full path to the extension directory
 * @param major - Major version from package.json (e.g., "1")
 * @returns SemVer version string (e.g., "1.47.0" or "1.47.0-dev.a1b2c3d4")
 */
async function getExtensionVersion(extDir: string, major: string): Promise<string> {
  const commits = getCommitCount(extDir);
  if (process.env.VERSION) {
    // Release: valid SemVer format required by VS Code
    return `${major}.${commits}.0`;
  }
  // Dev: SemVer with prerelease tag
  const hash = await hashExtensionFolder(extDir);
  return `${major}.${commits}.0-dev.${hash}`;
}

/**
 * Read and parse external.json to get external extension configs.
 * Format: [{ "id": "publisher.name", "version": "X.Y.Z" }]
 */
function readExternalExtensions(): ExternalExtension[] {
  try {
    const content = fs.readFileSync(EXTERNAL_JSON, "utf-8");
    const parsed: unknown = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      throw new Error("external.json must be an array of extension objects");
    }

    const extensions: ExternalExtension[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (typeof item !== "object" || item === null) {
        throw new Error(`external.json[${i}] must be an object with { id, version }`);
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.id !== "string" || !obj.id) {
        throw new Error(`external.json[${i}].id must be a non-empty string`);
      }
      if (typeof obj.version !== "string" || !obj.version) {
        throw new Error(`external.json[${i}].version must be a non-empty string`);
      }
      extensions.push({ id: obj.id, version: obj.version });
    }

    return extensions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("No external.json found, skipping external extensions");
      return [];
    }
    throw error;
  }
}

/**
 * Download a VS Code extension from the marketplace.
 *
 * URL format:
 * https://{publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/{publisher}/extension/{name}/{version}/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage
 *
 * @param ext Extension config with id and version
 * @returns Filename of the downloaded vsix
 */
async function downloadExtension(ext: ExternalExtension): Promise<string> {
  // Parse extension id: "publisher.name" -> publisher="publisher", name="name"
  const dotIndex = ext.id.indexOf(".");
  if (dotIndex === -1) {
    throw new Error(`Invalid extension id format: "${ext.id}". Expected "publisher.name"`);
  }
  const publisher = ext.id.slice(0, dotIndex);
  const name = ext.id.slice(dotIndex + 1);

  const url =
    `https://${publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/` +
    `${publisher}/extension/${name}/${ext.version}/assetbyname/` +
    `Microsoft.VisualStudio.Services.VSIXPackage`;

  // Use extension id (publisher.name) with dots replaced by hyphens for vsix filename
  const vsixName = `${ext.id.replace(/\./g, "-")}-${ext.version}.vsix`;
  const outputPath = path.join(DIST_DIR, vsixName);

  console.log(`  Downloading ${ext.id}@${ext.version}...`);
  console.log(`  URL: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${ext.id}@${ext.version}: HTTP ${response.status} ${response.statusText}`
    );
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));

  console.log(`  Downloaded ${vsixName} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
  return vsixName;
}

/**
 * Find all extension directories in extensions/.
 * Excludes files (like external.json, README.md).
 */
function findExtensionDirs(): string[] {
  const entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Read and validate an extension's package.json.
 */
function readExtensionPackageJson(extDir: string): ExtensionPackageJson {
  const packageJsonPath = path.join(EXTENSIONS_DIR, extDir, "package.json");
  const content = fs.readFileSync(packageJsonPath, "utf-8");
  const pkg: unknown = JSON.parse(content);

  if (typeof pkg !== "object" || pkg === null) {
    throw new Error(`${extDir}/package.json is not a valid object`);
  }

  const { publisher, name, version } = pkg as Record<string, unknown>;

  if (typeof publisher !== "string" || !publisher) {
    throw new Error(`${extDir}/package.json must have a 'publisher' field`);
  }
  if (typeof name !== "string" || !name) {
    throw new Error(`${extDir}/package.json must have a 'name' field`);
  }
  if (typeof version !== "string" || !version) {
    throw new Error(`${extDir}/package.json must have a 'version' field`);
  }

  return { publisher, name, version };
}

/**
 * Build and package an extension.
 * Runs: npm install && npm run build && vsce package
 * Version is computed from git history and injected at package time.
 *
 * Note: vsce package modifies package.json in-place when injecting the version.
 * We save and restore the original content to prevent git noise.
 */
async function buildExtension(
  extDir: string,
  id: string,
  major: string
): Promise<{ vsix: string; version: string }> {
  const extPath = path.join(EXTENSIONS_DIR, extDir);
  const packageJsonPath = path.join(extPath, "package.json");

  // Compute version from git history and folder hash
  const version = await getExtensionVersion(extPath, major);

  // Use extension id (publisher.name) with dots replaced by hyphens for vsix filename
  const vsixName = `${id.replace(/\./g, "-")}-${version}.vsix`;
  const outputPath = path.join(DIST_DIR, vsixName);

  console.log(`\nBuilding ${extDir}...`);
  console.log(`  Version: ${version}`);

  // Run npm install
  console.log(`  npm install...`);
  execSync("npm install", { cwd: extPath, stdio: "inherit" });

  // Run npm run build
  console.log(`  npm run build...`);
  execSync("npm run build", { cwd: extPath, stdio: "inherit" });

  // Save original package.json before vsce modifies it
  const originalContent = await fsp.readFile(packageJsonPath, "utf-8");

  try {
    // Package with vsce, injecting the computed version
    console.log(`  vsce package...`);
    execSync(
      `npx vsce package --no-dependencies --no-git-tag-version "${version}" -o "${outputPath}"`,
      {
        cwd: extPath,
        stdio: "inherit",
      }
    );

    console.log(`  Created ${vsixName}`);
    return { vsix: vsixName, version };
  } finally {
    // Restore original package.json to prevent git noise
    await fsp.writeFile(packageJsonPath, originalContent);
  }
}

async function main(): Promise<void> {
  console.log("Building VS Code extensions...\n");

  // Create dist/extensions/ directory
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // Read external extensions (will be downloaded from marketplace)
  const externalExtensions = readExternalExtensions();
  console.log(
    `External extensions: ${externalExtensions.length > 0 ? externalExtensions.map((e) => `${e.id}@${e.version}`).join(", ") : "(none)"}`
  );

  // Find and build all extension directories
  const extDirs = findExtensionDirs();
  console.log(`Extension directories: ${extDirs.length > 0 ? extDirs.join(", ") : "(none)"}`);

  const manifest: BundledExtension[] = [];

  // Build local extensions
  for (const extDir of extDirs) {
    const pkg = readExtensionPackageJson(extDir);
    const id = `${pkg.publisher}.${pkg.name}`;
    // Extract major version from placeholder (e.g., "1.0.0-placeholder" -> "1")
    const major = pkg.version.split(".")[0] ?? "1";
    const { vsix, version } = await buildExtension(extDir, id, major);

    manifest.push({
      id,
      version,
      vsix,
    });
  }

  // Download external extensions from marketplace
  if (externalExtensions.length > 0) {
    console.log("\nDownloading external extensions from marketplace...");
    for (const ext of externalExtensions) {
      try {
        const vsix = await downloadExtension(ext);
        manifest.push({
          id: ext.id,
          version: ext.version,
          vsix,
        });
      } catch (error) {
        // Build must fail if external extension cannot be downloaded
        console.error(`\nFailed to download extension: ${ext.id}@${ext.version}`);
        throw error;
      }
    }
  }

  // Write manifest.json as a flat array (new format)
  const manifestPath = path.join(DIST_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nGenerated manifest.json:`);
  console.log(JSON.stringify(manifest, null, 2));

  console.log("\nExtension build complete!");
}

main().catch((error) => {
  console.error("\nError building extensions:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
