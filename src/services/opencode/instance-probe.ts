/**
 * Instance probe for discovering OpenCode instances.
 * Probes a port to determine if it's running an OpenCode instance.
 */

import { type HttpClient } from "../platform/network";
import { ok, err, type Result, type ProbeError, type PathResponse } from "./types";

/**
 * Interface for probing potential OpenCode instances.
 * Abstracts the underlying implementation for testability.
 */
export interface InstanceProbe {
  /**
   * Probe a port to check if it's an OpenCode instance.
   * @param port Port number to probe
   * @returns Result containing workspace path or probe error
   */
  probe(port: number): Promise<Result<string, ProbeError>>;
}

/**
 * Type guard for PathResponse.
 */
function isPathResponse(value: unknown): value is PathResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "worktree" in value &&
    typeof (value as PathResponse).worktree === "string"
  );
}

/**
 * HTTP-based instance probe implementation.
 * SECURITY: Only probes localhost addresses.
 */
export class HttpInstanceProbe implements InstanceProbe {
  private readonly timeout: number;

  constructor(
    private readonly httpClient: HttpClient,
    timeout = 5000
  ) {
    this.timeout = timeout;
  }

  async probe(port: number): Promise<Result<string, ProbeError>> {
    // SECURITY: Hard-coded localhost restriction
    const url = `http://localhost:${port}/path`;

    try {
      const response = await this.httpClient.fetch(url, { timeout: this.timeout });

      if (!response.ok) {
        return err({
          code: "NOT_OPENCODE",
          message: `Non-200 response: ${response.status}`,
        });
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return err({
          code: "INVALID_RESPONSE",
          message: "Response is not valid JSON",
        });
      }

      if (!isPathResponse(data)) {
        return err({
          code: "NOT_OPENCODE",
          message: "Response missing worktree field or invalid structure",
        });
      }

      return ok(data.worktree);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return err({
          code: "TIMEOUT",
          message: "Request timed out",
          cause: error,
        });
      }

      return err({
        code: "CONNECTION_REFUSED",
        message: error instanceof Error ? error.message : "Unknown error",
        cause: error,
      });
    }
  }
}
