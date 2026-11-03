/**
 * Build the Windows process helper, codehydra-procs.exe (resources/win-helper).
 *
 * A .NET Framework 4.8 exe, compiled with the .NET SDK (`dotnet build`) — which
 * runs on Linux, macOS and Windows alike, so every build produces it. Windows
 * runs it with the .NET Framework it ships; nothing needs installing there.
 *
 * Without `dotnet` on PATH the build skips with a warning, so a dev without the
 * SDK can still build and run on Linux/macOS (which never use the helper). On CI
 * (`CI` set) or with `--require` a missing SDK fails instead, so no package ships
 * without the helper.
 *
 * Usage: tsx scripts/build-win-helper.ts [--into <dir>] [--require]
 *   default    writes dist/bin/codehydra-procs.exe, which electron-vite copies
 *              into out/main/assets/bin with the other bundled binaries
 *   --into     writes into <dir> instead
 *   --require  fail instead of skipping when `dotnet` is missing
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SOURCE_DIR = resolve("resources", "win-helper");
const PROJECT = join(SOURCE_DIR, "codehydra-procs.csproj");
const EXE_NAME = "codehydra-procs.exe";
// dotnet's obj/ and bin/ — out of the source tree, kept between builds.
const WORK_DIR = resolve("node_modules", ".cache", "win-helper");

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const outDir = resolve(argValue("--into") ?? join("dist", "bin"));
const required = process.argv.includes("--require") || Boolean(process.env["CI"]);
const output = join(outDir, EXE_NAME);

// Up to date: newer than every input (sources, project, SDK pin).
const inputs = readdirSync(SOURCE_DIR).map((name) => join(SOURCE_DIR, name));
if (existsSync(output)) {
  const built = statSync(output).mtimeMs;
  if (inputs.every((input) => statSync(input).mtimeMs < built)) {
    console.log(`build-win-helper: ${output} is up to date`);
    process.exit(0);
  }
}

try {
  execFileSync("dotnet", ["--version"], { cwd: SOURCE_DIR, stdio: "ignore" });
} catch {
  const message =
    `the .NET SDK (\`dotnet\`, 8 or newer) is needed to build ${EXE_NAME} ` +
    "(https://dotnet.microsoft.com/download)";
  if (required) {
    console.error(`build-win-helper: ${message}`);
    process.exit(1);
  }
  console.warn(`build-win-helper: skipped — ${message}. Windows needs it; Linux and macOS do not.`);
  process.exit(0);
}

const staging = join(WORK_DIR, "out");
execFileSync(
  "dotnet",
  [
    "build",
    PROJECT,
    "--configuration",
    "Release",
    "--nologo",
    "--artifacts-path",
    join(WORK_DIR, "artifacts"),
    "--output",
    staging,
  ],
  // cwd: dotnet resolves global.json from here.
  { cwd: SOURCE_DIR, stdio: "inherit", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } }
);

mkdirSync(outDir, { recursive: true });
copyFileSync(join(staging, EXE_NAME), output);
console.log(`build-win-helper: built ${output}`);
