/**
 * Sign macOS .app bundles with rcodesign for ad-hoc code signing.
 *
 * Downloads rcodesign if not available, then signs all .app bundles
 * found in the specified directory (or all dist/mac* directories).
 *
 * Usage: pnpm sign:mac                           # Sign all .app bundles in dist/
 *        tsx scripts/sign-macos.ts dist/mac-arm64 # Sign .app bundles in specific dir
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const RCODESIGN_VERSION = "0.29.0";
const CACHE_DIR = path.join("/tmp", `rcodesign-${RCODESIGN_VERSION}`);
const ENTITLEMENTS_PATH = path.join(process.cwd(), "resources", "entitlements.mac.plist");

function getRcodesignUrl(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const triple = `${arch}-unknown-linux-musl`;
  const tag = encodeURIComponent(`apple-codesign/${RCODESIGN_VERSION}`);
  return `https://github.com/indygreg/apple-platform-rs/releases/download/${tag}/apple-codesign-${RCODESIGN_VERSION}-${triple}.tar.gz`;
}

/** Check if rcodesign is available on the system PATH. */
function findSystemRcodesign(): string | undefined {
  try {
    execFileSync("rcodesign", ["--version"], { stdio: "ignore" });
    return "rcodesign";
  } catch {
    return undefined;
  }
}

/** Check if rcodesign is cached from a previous download. */
function findCachedRcodesign(): string | undefined {
  const cached = path.join(CACHE_DIR, "rcodesign");
  try {
    execFileSync(cached, ["--version"], { stdio: "ignore" });
    return cached;
  } catch {
    return undefined;
  }
}

/** Find rcodesign from system PATH or cache. */
function findRcodesign(): string | undefined {
  return findSystemRcodesign() ?? findCachedRcodesign();
}

/** Download and cache rcodesign. */
async function downloadRcodesign(): Promise<string> {
  const url = getRcodesignUrl();
  const targetPath = path.join(CACHE_DIR, "rcodesign");
  const tempTarball = path.join(CACHE_DIR, "download.tar.gz");

  console.log(`Downloading rcodesign v${RCODESIGN_VERSION}...`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download rcodesign: HTTP ${response.status}`);
  }

  // Download to temp file
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(tempTarball, buffer);

  // Extract rcodesign binary (strip top-level directory)
  execFileSync("tar", ["xzf", tempTarball, "--strip-components=1", "-C", CACHE_DIR], {
    stdio: "pipe",
  });

  fs.unlinkSync(tempTarball);
  fs.chmodSync(targetPath, 0o755);

  const version = execFileSync(targetPath, ["--version"], { encoding: "utf-8" }).trim();
  console.log(`  Installed: ${version}`);

  return targetPath;
}

/** Find .app bundles in the given directories. */
function findAppBundles(dirs: string[]): string[] {
  const bundles: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        bundles.push(path.join(dir, entry.name));
      }
    }
  }
  return bundles;
}

/** Sign a single .app bundle with rcodesign. */
function signBundle(rcodesign: string, bundle: string): void {
  console.log(`\nSigning ${path.basename(bundle)}...`);
  execFileSync(rcodesign, ["sign", "--entitlements-xml-file", ENTITLEMENTS_PATH, bundle], {
    stdio: "inherit",
  });
  console.log(`  Signed successfully`);
}

async function main(): Promise<void> {
  // Parse args: positional dirs only, ignore flags (e.g. --publish=never from pnpm passthrough)
  const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

  // Determine directories to search
  let searchDirs: string[];
  if (dirs.length > 0) {
    searchDirs = dirs;
  } else {
    try {
      searchDirs = fs
        .readdirSync("dist", { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith("mac"))
        .map((e) => path.join("dist", e.name));
    } catch {
      searchDirs = [];
    }
  }

  const bundles = findAppBundles(searchDirs);
  if (bundles.length === 0) {
    console.error("No .app bundles found to sign");
    if (dirs.length > 0) {
      console.error(`Searched in: ${dirs.join(", ")}`);
    }
    process.exit(1);
  }

  console.log(`Found ${bundles.length} .app bundle(s) to sign`);

  if (!fs.existsSync(ENTITLEMENTS_PATH)) {
    console.error(`Entitlements file not found: ${ENTITLEMENTS_PATH}`);
    process.exit(1);
  }

  // Get or download rcodesign
  let rcodesign = findRcodesign();
  if (!rcodesign) {
    rcodesign = await downloadRcodesign();
  } else {
    console.log(`Using rcodesign: ${rcodesign}`);
  }

  for (const bundle of bundles) {
    signBundle(rcodesign, bundle);
  }

  console.log(`\nSigned ${bundles.length} bundle(s)`);
}

main().catch((error) => {
  console.error("\nError signing macOS bundles:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
