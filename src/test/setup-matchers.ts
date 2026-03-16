/**
 * Matcher registration for test setup.
 *
 * This file imports state-mock.ts which auto-registers base matchers (toBeUnchanged).
 * Mock-specific matchers are auto-registered via side-effect imports.
 */

// Register base matchers for MockWithState
import "./state-mock";

// Register filesystem matchers (auto-registers via expect.extend on import)
import "../boundaries/platform/filesystem.state-mock";

// Register process runner matchers (auto-registers via expect.extend on import)
import "../boundaries/platform/process.state-mock";

// Register view layer matchers (auto-registers via expect.extend on import)
import "../boundaries/shell/view.state-mock";
