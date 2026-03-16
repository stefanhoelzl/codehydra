/**
 * Health check polling utility for server readiness checks.
 *
 * Provides a shared implementation for waiting until a service becomes healthy.
 */

/**
 * Configuration for health check polling.
 */
export interface HealthCheckConfig {
  /** Function that returns true when healthy, false otherwise */
  readonly checkFn: () => Promise<boolean>;
  /** Total timeout in milliseconds */
  readonly timeoutMs: number;
  /** Interval between checks in milliseconds */
  readonly intervalMs: number;
  /** Custom error message on timeout (optional) */
  readonly errorMessage?: string;
}

/**
 * Wait for a health check to pass.
 * Polls the check function until it returns true or timeout is reached.
 *
 * @param config - Health check configuration
 * @throws Error if timeout is reached before health check passes
 *
 * @example
 * ```typescript
 * await waitForHealthy({
 *   checkFn: async () => {
 *     const response = await httpClient.fetch(url);
 *     return response.ok;
 *   },
 *   timeoutMs: 30000,
 *   intervalMs: 100,
 *   errorMessage: "Server failed to start",
 * });
 * ```
 */
export async function waitForHealthy(config: HealthCheckConfig): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < config.timeoutMs) {
    try {
      if (await config.checkFn()) {
        return;
      }
    } catch {
      // Continue retrying on errors
    }

    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }

  throw new Error(config.errorMessage ?? `Health check timeout after ${config.timeoutMs}ms`);
}
