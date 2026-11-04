/**
 * Build the native addon (native/, Rust + napi-rs) for one target.
 *
 * Writes dist/bin/codehydra-native.<platform>-<arch>.node, which electron-vite
 * copies into out/main/assets/bin with the other bundled binaries; main.ts
 * loads the one matching the running platform (src/boundaries/platform/native-addon.ts).
 *
 * The app cannot list processes without it, so a missing Rust toolchain fails
 * the build rather than skipping. `cargo` comes from rustup
 * (https://rustup.rs); native/rust-toolchain.toml pins the version, which
 * rustup installs on first use.
 *
 * Usage: tsx scripts/build-native.ts [--target <rust triple>] [--into <dir>]
 *   default    builds for this machine
 *   --target   cross-builds, e.g. x86_64-apple-darwin on an arm64 Mac
 *   --into     writes into <dir> instead of dist/bin
 *
 * A packaged build carries the addon of every platform: the Linux build job
 * runs once and the per-OS packaging reuses its output, so CI builds each
 * target on its own OS and drops the files into dist/bin before `pnpm build`.
 * A file there that is newer than every source counts as built, so those
 * prebuilt files are kept, not rebuilt.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const CRATE_DIR = resolve("native");
const LIB_NAME = "codehydra_native";

/** Rust target triple → Node's `${process.platform}-${process.arch}`. */
const TARGETS: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-pc-windows-msvc": "win32-x64",
  "aarch64-pc-windows-msvc": "win32-arm64",
};

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const target = argValue("--target");
let nodeTarget: string;
if (target === undefined) {
  nodeTarget = `${process.platform}-${process.arch}`;
  if (!Object.values(TARGETS).includes(nodeTarget)) {
    console.error(`build-native: no Rust target known for ${nodeTarget}`);
    process.exit(1);
  }
} else {
  const known = TARGETS[target];
  if (known === undefined) {
    console.error(
      `build-native: unknown target ${target} (known: ${Object.keys(TARGETS).join(", ")})`
    );
    process.exit(1);
  }
  nodeTarget = known;
}

const outDir = resolve(argValue("--into") ?? join("dist", "bin"));
const output = join(outDir, `codehydra-native.${nodeTarget}.node`);

/** Every file under `dir`. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** The build's inputs: the crate root's files (manifest, lockfile, toolchain pin, build.rs) and src/. */
const inputs = [
  ...readdirSync(CRATE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(CRATE_DIR, entry.name)),
  ...filesUnder(join(CRATE_DIR, "src")),
];

if (existsSync(output)) {
  const built = statSync(output).mtimeMs;
  if (inputs.every((input) => statSync(input).mtimeMs < built)) {
    console.log(`build-native: ${output} is up to date`);
    process.exit(0);
  }
}

try {
  execFileSync("cargo", ["--version"], { cwd: CRATE_DIR, stdio: "ignore" });
} catch {
  console.error(
    "build-native: Rust (`cargo`) is needed to build the native addon — install it with rustup (https://rustup.rs)"
  );
  process.exit(1);
}

execFileSync(
  "cargo",
  ["build", "--release", "--locked", ...(target === undefined ? [] : ["--target", target])],
  { cwd: CRATE_DIR, stdio: "inherit" }
);

const platform = nodeTarget.split("-")[0];
const libFile =
  platform === "win32"
    ? `${LIB_NAME}.dll`
    : platform === "darwin"
      ? `lib${LIB_NAME}.dylib`
      : `lib${LIB_NAME}.so`;
const built = join(
  CRATE_DIR,
  "target",
  ...(target === undefined ? [] : [target]),
  "release",
  libFile
);

mkdirSync(outDir, { recursive: true });
copyFileSync(built, output);
console.log(`build-native: built ${output}`);
