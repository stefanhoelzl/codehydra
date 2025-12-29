/**
 * Post-build validation script for distribution builds.
 *
 * Validates that the build output is correct before creating distributables:
 * - dist/extensions/ exists (extension build worked)
 * - out/main/assets/*.vsix exists (vite copy worked)
 * - Distributable file exists and size < 300MB
 *
 * Usage: npx tsx scripts/validate-dist.ts [--platform linux|win]
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_SIZE_MB = 300;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

interface ValidationResult {
  passed: boolean;
  message: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function checkDistExtensions(): ValidationResult {
  const distExtensionsDir = path.join(process.cwd(), "dist", "extensions");

  try {
    const stat = fs.statSync(distExtensionsDir);
    if (!stat.isDirectory()) {
      return { passed: false, message: "dist/extensions/ is not a directory" };
    }

    // Check for .vsix files
    const files = fs.readdirSync(distExtensionsDir);
    const vsixFiles = files.filter((f) => f.endsWith(".vsix"));

    if (vsixFiles.length === 0) {
      return { passed: false, message: "No .vsix files in dist/extensions/" };
    }

    return {
      passed: true,
      message: `dist/extensions/ contains ${vsixFiles.length} .vsix file(s): ${vsixFiles.join(", ")}`,
    };
  } catch {
    return { passed: false, message: "dist/extensions/ does not exist" };
  }
}

function checkOutMainAssets(): ValidationResult {
  const assetsDir = path.join(process.cwd(), "out", "main", "assets");

  try {
    const stat = fs.statSync(assetsDir);
    if (!stat.isDirectory()) {
      return { passed: false, message: "out/main/assets/ is not a directory" };
    }

    // Check for .vsix files
    const files = fs.readdirSync(assetsDir);
    const vsixFiles = files.filter((f) => f.endsWith(".vsix"));

    if (vsixFiles.length === 0) {
      return { passed: false, message: "No .vsix files in out/main/assets/ (vite copy failed)" };
    }

    return {
      passed: true,
      message: `out/main/assets/ contains ${vsixFiles.length} .vsix file(s): ${vsixFiles.join(", ")}`,
    };
  } catch {
    return { passed: false, message: "out/main/assets/ does not exist" };
  }
}

function findDistributable(platform: string | null): string | null {
  const distDir = path.join(process.cwd(), "dist");

  try {
    const files = fs.readdirSync(distDir);

    // Find distributable based on platform
    if (platform === "linux" || platform === null) {
      const appImage = files.find((f) => f.endsWith(".AppImage"));
      if (appImage) return path.join(distDir, appImage);
    }

    if (platform === "win" || platform === null) {
      // Windows portable exe (not the unpacked directory)
      const exe = files.find((f) => f.endsWith(".exe") && !f.includes("unpacked"));
      if (exe) return path.join(distDir, exe);
    }

    return null;
  } catch {
    return null;
  }
}

function checkDistributable(platform: string | null): ValidationResult {
  const distributablePath = findDistributable(platform);

  if (!distributablePath) {
    const expected =
      platform === "linux" ? ".AppImage" : platform === "win" ? ".exe" : "distributable";
    return { passed: false, message: `No ${expected} file found in dist/` };
  }

  const stat = fs.statSync(distributablePath);
  const filename = path.basename(distributablePath);
  const size = stat.size;

  if (size > MAX_SIZE_BYTES) {
    return {
      passed: false,
      message: `${filename} is too large: ${formatBytes(size)} (max: ${MAX_SIZE_MB}MB)`,
    };
  }

  return {
    passed: true,
    message: `${filename} exists and size is ${formatBytes(size)} (< ${MAX_SIZE_MB}MB)`,
  };
}

function main(): void {
  console.log("\nValidating distribution build...\n");

  // Parse platform argument
  let platform: string | null = null;
  const platformIndex = process.argv.indexOf("--platform");
  if (platformIndex !== -1 && process.argv[platformIndex + 1]) {
    platform = process.argv[platformIndex + 1];
    if (platform !== "linux" && platform !== "win") {
      console.error(`Invalid platform: ${platform}. Must be 'linux' or 'win'.`);
      process.exit(1);
    }
  }

  const checks: Array<{ name: string; result: ValidationResult }> = [
    { name: "Extension build", result: checkDistExtensions() },
    { name: "Vite asset copy", result: checkOutMainAssets() },
    { name: "Distributable file", result: checkDistributable(platform) },
  ];

  let allPassed = true;

  for (const check of checks) {
    const icon = check.result.passed ? "✓" : "✗";
    console.log(`${icon} ${check.name}: ${check.result.message}`);
    if (!check.result.passed) {
      allPassed = false;
    }
  }

  console.log("");

  if (allPassed) {
    console.log("All validation checks passed!");
  } else {
    console.error("Validation failed. See errors above.");
    process.exit(1);
  }
}

main();
