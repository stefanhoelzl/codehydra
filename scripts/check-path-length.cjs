/**
 * Windows MAX_PATH Check
 *
 * Runs before npm install to warn users about potential path length issues.
 * Uses CommonJS (.cjs) to work regardless of package.json "type" setting.
 *
 * This script:
 * 1. Exits silently on non-Windows platforms
 * 2. Checks if Windows Long Paths are enabled in the registry
 * 3. Warns if the project path is long AND long paths are not enabled
 */

// Only run on Windows
if (process.platform !== "win32") {
  process.exit(0);
}

const { execSync } = require("child_process");

// Threshold based on real failure: install failed at 91 character base path
const PATH_LENGTH_THRESHOLD = 90;
const cwd = process.cwd();

/**
 * Check if Windows Long Paths are enabled in the registry.
 * Reading the registry does not require elevated permissions.
 */
function isLongPathEnabled() {
  try {
    const output = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return output.includes("0x1");
  } catch {
    // Key doesn't exist or error - assume disabled
    return false;
  }
}

// Exit silently if long paths are enabled
if (isLongPathEnabled()) {
  process.exit(0);
}

// Exit silently if path is short enough
if (cwd.length <= PATH_LENGTH_THRESHOLD) {
  process.exit(0);
}

// Warn the user
console.warn(`
================================================================================
  WARNING: Windows MAX_PATH Limitation Detected
================================================================================

Your project path is ${cwd.length} characters long, which may cause npm install
to fail due to Windows' 260 character path limit.

Current path:
  ${cwd}

Solutions:

  1. Enable Windows Long Paths (recommended, requires admin + reboot):
     reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f

  2. Move this project to a shorter path (e.g., C:\\dev\\project)

Continuing with install...
================================================================================
`);

// Exit with 0 to continue installation (this is just a warning)
process.exit(0);
