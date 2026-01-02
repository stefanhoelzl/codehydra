/**
 * Matcher registration for test setup.
 *
 * This file imports state-mock.ts which auto-registers base matchers (toBeUnchanged).
 *
 * Mock-specific matchers (like httpClientMatchers) are auto-registered when their
 * respective mock modules are imported. This keeps the setup file renderer-compatible
 * (no imports from src/services/* which contain node-specific code).
 */

// Register base matchers for MockWithState
import "./state-mock";
