/**
 * Build script for VS Code extensions.
 *
 * This script:
 * 1. Discovers all extension folders in extensions/
 * 2. Builds and packages each extension as a .vsix file
 * 3. Generates dist/extensions/manifest.json with the complete extension manifest
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

interface Manifest {
  marketplace: string[];
  bundled: BundledExtension[];
}

/**
 * Read and parse external.json to get marketplace extension IDs.
 */
function readExternalExtensions(): string[] {
  try {
    const content = fs.readFileSync(EXTERNAL_JSON, "utf-8");
    const parsed: unknown = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      throw new Error("external.json must be an array of extension IDs");
    }

    for (const item of parsed) {
      if (typeof item !== "string") {
        throw new Error("external.json must contain only string extension IDs");
      }
    }

    return parsed as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("No external.json found, skipping marketplace extensions");
      return [];
    }
    throw error;
  }
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

  // Read external extensions (marketplace)
  const marketplace = readExternalExtensions();
  console.log(
    `Marketplace extensions: ${marketplace.length > 0 ? marketplace.join(", ") : "(none)"}`
  );

  // Find and build all extension directories
  const extDirs = findExtensionDirs();
  console.log(`Extension directories: ${extDirs.length > 0 ? extDirs.join(", ") : "(none)"}`);

  const bundled: BundledExtension[] = [];

  for (const extDir of extDirs) {
    const pkg = readExtensionPackageJson(extDir);
    const id = `${pkg.publisher}.${pkg.name}`;
    const vsix = buildExtension(extDir, id, pkg.version);

    bundled.push({
      id,
      version: pkg.version,
      vsix,
    });
  }

  // Write manifest.json
  const manifest: Manifest = { marketplace, bundled };
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
