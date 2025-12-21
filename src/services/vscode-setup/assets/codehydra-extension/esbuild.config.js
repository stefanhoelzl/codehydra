// @ts-check
const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["./extension.js"],
    outfile: "./dist/extension.js",
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    // VS Code API is provided at runtime
    // bufferutil and utf-8-validate are optional native deps for ws (used by socket.io)
    external: ["vscode", "bufferutil", "utf-8-validate"],
    minify: false, // Keep readable for debugging
    sourcemap: false,
  })
  .then(() => {
    console.log("Extension bundled successfully");
  })
  .catch((err) => {
    console.error("Bundle failed:", err);
    process.exit(1);
  });
