/**
 * Test utilities for services.
 * Re-exports common test utilities for use in tests.
 */

export {
  ensureBinaryForTests,
  ensureBinariesForTests,
  isBinaryInstalled,
  getBinaryPathForTests,
  getTestPathProvider,
  CODE_SERVER_VERSION,
  OPENCODE_VERSION,
  type EnsureBinaryOptions,
} from "./ensure-binaries";

// Re-export the existing createTempDir from the parent test-utils module
export { createTempDir } from "../test-utils";
