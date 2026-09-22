/**
 * Launch the built app (`electron-vite preview`) with `_CH_DATA_DIR` set.
 *
 * `pnpm preview` is usually run from a terminal or agent of an installed
 * CodeHydra, so the app it starts inherits that instance's `_CH_*` variables —
 * and so does every terminal and agent inside it. `_CH_DATA_DIR` outranks them
 * in the `ch` CLI, so pointing it at the preview's own data root makes `ch`
 * there talk to the preview instead of the instance it was launched from.
 *
 * The root mirrors the path provider's rule for a development build: an
 * explicit `_CH_ROOT_DIR`, else `./app-data`.
 *
 * Usage: pnpm preview (builds first)
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

const dataRoot = process.env._CH_ROOT_DIR || path.join(process.cwd(), "app-data");

const result = spawnSync("electron-vite", ["preview", "--skipBuild", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, _CH_DATA_DIR: dataRoot },
  // electron-vite is a .cmd shim on Windows, which only a shell can run.
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
