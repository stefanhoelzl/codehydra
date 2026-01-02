// @ts-check
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// Copy webview assets to dist
function copyAssets() {
  const srcDir = path.join(__dirname, "src", "audio");
  const destDir = path.join(__dirname, "dist", "audio");

  // Create dest directory if it doesn't exist
  fs.mkdirSync(destDir, { recursive: true });

  // Copy HTML and JS files
  const files = ["webview.html", "audio-processor.js"];
  for (const file of files) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // Copy codicons font file for webview
  const codiconsDir = path.join(__dirname, "dist", "codicons");
  fs.mkdirSync(codiconsDir, { recursive: true });
  const codiconsSrc = path.join(
    __dirname,
    "node_modules",
    "@vscode",
    "codicons",
    "dist",
    "codicon.ttf"
  );
  const codiconsDest = path.join(codiconsDir, "codicon.ttf");
  if (fs.existsSync(codiconsSrc)) {
    fs.copyFileSync(codiconsSrc, codiconsDest);
  }
}

esbuild
  .build({
    entryPoints: ["./src/extension.ts"],
    outfile: "./dist/extension.js",
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    // VS Code API is provided at runtime
    // bufferutil and utf-8-validate are optional native deps for ws (used by assemblyai)
    external: ["vscode", "bufferutil", "utf-8-validate"],
    minify: false, // Keep readable for debugging
    sourcemap: false,
  })
  .then(() => {
    copyAssets();
    console.log("Extension bundled successfully");
  })
  .catch((err) => {
    console.error("Bundle failed:", err);
    process.exit(1);
  });
