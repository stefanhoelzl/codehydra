/**
 * Build script for VS Code extensions.
 *
 * This script:
 * 1. Discovers all extension folders in extensions/
 * 2. Builds and packages each extension as a .vsix file
 * 3. Downloads external extensions from VS Code Marketplace
 * 4. Generates dist/extensions/manifest.json with the complete extension manifest
 *
 * Usage: npm run build:extensions
 *        npx tsx scripts/build-extensions.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

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
 */
function buildExtension(extDir: string, id: string, version: string): string {
  const extPath = path.join(EXTENSIONS_DIR, extDir);
  // Use extension id (publisher.name) with dots replaced by hyphens for vsix filename
  const vsixName = `${id.replace(/\./g, "-")}-${version}.vsix`;
  const outputPath = path.join(DIST_DIR, vsixName);

  console.log(`\nBuilding ${extDir}...`);

  // Run npm install
  console.log(`  npm install...`);
  execSync("npm install", { cwd: extPath, stdio: "inherit" });

  // Run npm run build
  console.log(`  npm run build...`);
  execSync("npm run build", { cwd: extPath, stdio: "inherit" });

  // Package with vsce
  console.log(`  vsce package...`);
  execSync(`npx vsce package --no-dependencies -o "${outputPath}"`, {
    cwd: extPath,
    stdio: "inherit",
  });

  console.log(`  Created ${vsixName}`);
  return vsixName;
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
    const vsix = buildExtension(extDir, id, pkg.version);

    manifest.push({
      id,
      version: pkg.version,
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
