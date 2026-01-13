#!/usr/bin/env node
// CodeHydra launcher for npm
// Downloads and caches the appropriate binary from GitHub Releases

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");

const VERSION = require("./package.json").version;
const REPO = "stefanhoelzl/codehydra";

// Platform/arch to GitHub asset mapping
const ASSET_MAP = {
  "linux-x64": "CodeHydra-linux-x64.AppImage",
  "darwin-x64": "CodeHydra-darwin-x64.zip",
  "darwin-arm64": "CodeHydra-darwin-arm64.zip",
  "win32-x64": "CodeHydra-win-portable-x64.zip",
};

function getCacheDir() {
  const platform = os.platform();
  if (platform === "linux") {
    return path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
      "codehydra",
      "releases",
      VERSION
    );
  } else if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Codehydra",
      "releases",
      VERSION
    );
  } else if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Codehydra",
      "releases",
      VERSION
    );
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

function getAssetName() {
  const key = `${os.platform()}-${os.arch()}`;
  const asset = ASSET_MAP[key];
  if (!asset) {
    throw new Error(`Unsupported platform: ${key}`);
  }
  return asset;
}

function getBinaryPath(cacheDir, assetName) {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(cacheDir, "CodeHydra-win-portable-x64", "CodeHydra.exe");
  } else if (platform === "darwin") {
    const appName = assetName.replace(".zip", "");
    return path.join(cacheDir, appName, "CodeHydra.app", "Contents", "MacOS", "CodeHydra");
  }
  return path.join(cacheDir, assetName);
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + ".tmp";
    https
      .get(url, { headers: { "User-Agent": `codehydra-npm/${VERSION}` } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, destPath).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }
        const file = fs.createWriteStream(tmpPath);
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            fs.renameSync(tmpPath, destPath);
            resolve();
          });
        });
        file.on("error", reject);
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  const cacheDir = getCacheDir();
  const assetName = getAssetName();
  const binaryPath = getBinaryPath(cacheDir, assetName);

  if (!fs.existsSync(binaryPath)) {
    console.log(`Downloading CodeHydra ${VERSION}...`);
    fs.mkdirSync(cacheDir, { recursive: true });

    const downloadUrl = `https://github.com/${REPO}/releases/download/v${VERSION}/${assetName}`;
    const downloadPath = path.join(cacheDir, assetName);
    await download(downloadUrl, downloadPath);

    if (assetName.endsWith(".zip")) {
      console.log("Extracting...");
      if (os.platform() === "win32") {
        execSync(
          `powershell -Command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${cacheDir}' -Force"`,
          { stdio: "pipe" }
        );
      } else {
        execSync(`unzip -q -o "${downloadPath}" -d "${cacheDir}"`, { stdio: "pipe" });
      }
      fs.unlinkSync(downloadPath);
    }

    if (os.platform() !== "win32") {
      fs.chmodSync(binaryPath, 0o755);
    }
    console.log("Done!\n");
  }

  const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code || 0));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
