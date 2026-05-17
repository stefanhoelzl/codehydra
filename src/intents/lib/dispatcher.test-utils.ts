/**
 * Test utilities for Dispatcher.
 */
import { Dispatcher } from "./dispatcher";
import { createMockLogger } from "../../boundaries/platform/logging.test-utils";

/**
 * Create a Dispatcher with a silent mock logger. The default for tests that
 * don't care about log output.
 */
export function createMockDispatcher(): Dispatcher {
  return new Dispatcher({ logger: createMockLogger() });
}
