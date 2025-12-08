/**
 * Port scanner using systeminformation.
 * Scans for listening ports and returns port/PID information.
 */

import si from "systeminformation";
import { ok, err, type Result, type PortInfo, type ScanError } from "./types";

/**
 * Interface for port scanning operations.
 * Abstracts the underlying implementation for testability.
 */
export interface PortScanner {
  /**
   * Scan for listening ports.
   * @returns Result containing array of port info or scan error
   */
  scan(): Promise<Result<PortInfo[], ScanError>>;
}

/**
 * Port scanner implementation using systeminformation.
 */
export class SiPortScanner implements PortScanner {
  async scan(): Promise<Result<PortInfo[], ScanError>> {
    try {
      const connections = await si.networkConnections();

      const ports: PortInfo[] = connections
        .filter((conn) => (conn.state === "LISTEN" || conn.state === "ESTABLISHED") && conn.pid > 0)
        .map((conn) => ({
          port: parseInt(conn.localPort, 10),
          pid: conn.pid,
        }));

      return ok(ports);
    } catch (error) {
      return err({
        code: "NETSTAT_FAILED",
        message: error instanceof Error ? error.message : "Unknown error",
        cause: error,
      });
    }
  }
}
