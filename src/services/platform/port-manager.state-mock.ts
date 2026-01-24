/**
 * Behavioral state mock for PortManager.
 *
 * Provides a sequential port allocation mock that follows the
 * `MockWithState<T>` pattern from `src/test/state-mock.ts`.
 */

import type { PortManager } from "./network";
import type { MockState, MockWithState, Snapshot } from "../../test/state-mock";

/**
 * Configuration options for the PortManager mock.
 */
export interface PortManagerMockOptions {
  /** Ports to return sequentially from findFreePort(). Default: [8080] */
  readonly ports?: readonly number[];
  /** Ports that should be reported as unavailable by isPortAvailable(). Default: [] */
  readonly unavailablePorts?: readonly number[];
}

/**
 * State for the PortManager mock.
 * Tracks remaining ports to allocate and ports already allocated.
 */
export class PortManagerMockState implements MockState {
  private _remainingPorts: number[];
  private _allocatedPorts: number[] = [];
  private _unavailablePorts: Set<number>;
  private _portAvailabilityChecks: number[] = [];

  constructor(ports: readonly number[], unavailablePorts: readonly number[] = []) {
    this._remainingPorts = [...ports];
    this._unavailablePorts = new Set(unavailablePorts);
  }

  /**
   * Ports available for future allocation.
   */
  get remainingPorts(): readonly number[] {
    return this._remainingPorts;
  }

  /**
   * Ports that have been allocated (in order of allocation).
   */
  get allocatedPorts(): readonly number[] {
    return this._allocatedPorts;
  }

  /**
   * Ports checked via isPortAvailable() (in order of checking).
   */
  get portAvailabilityChecks(): readonly number[] {
    return this._portAvailabilityChecks;
  }

  /**
   * Allocate the next available port.
   * @throws Error if no ports available
   */
  allocateNext(): number {
    const port = this._remainingPorts.shift();
    if (port === undefined) {
      throw new Error("No ports available");
    }
    this._allocatedPorts.push(port);
    return port;
  }

  /**
   * Check if a port is available.
   * Records the check and returns false if port is in the unavailable set.
   */
  checkPortAvailable(port: number): boolean {
    this._portAvailabilityChecks.push(port);
    return !this._unavailablePorts.has(port);
  }

  /**
   * Mark a port as unavailable for isPortAvailable checks.
   */
  markPortUnavailable(port: number): void {
    this._unavailablePorts.add(port);
  }

  /**
   * Mark a port as available for isPortAvailable checks.
   */
  markPortAvailable(port: number): void {
    this._unavailablePorts.delete(port);
  }

  snapshot(): Snapshot {
    return {
      __brand: "Snapshot",
      value: this.toString(),
    };
  }

  toString(): string {
    return `PortManagerMockState { remaining: [${this._remainingPorts.join(", ")}], allocated: [${this._allocatedPorts.join(", ")}], unavailable: [${[...this._unavailablePorts].join(", ")}] }`;
  }
}

/**
 * Mock PortManager with inspectable state.
 */
export type MockPortManager = PortManager & MockWithState<PortManagerMockState>;

/**
 * Create a mock PortManager that returns ports sequentially from a configured list.
 *
 * The mock tracks state via the `$` property, following the behavioral mock pattern.
 * When all ports are exhausted, `findFreePort()` throws an error.
 *
 * @param portsOrOptions - Array of ports to return sequentially, or options object. Default: `[8080]`
 * @returns MockPortManager with `$` property for state inspection
 *
 * @example Basic usage - single port
 * ```ts
 * const portManager = createPortManagerMock();
 * const port = await portManager.findFreePort();
 * expect(port).toBe(8080);
 * ```
 *
 * @example Custom port
 * ```ts
 * const portManager = createPortManagerMock([3000]);
 * const port = await portManager.findFreePort();
 * expect(port).toBe(3000);
 * ```
 *
 * @example Sequential ports
 * ```ts
 * const portManager = createPortManagerMock([8080, 8081, 8082]);
 * expect(await portManager.findFreePort()).toBe(8080);
 * expect(await portManager.findFreePort()).toBe(8081);
 * expect(await portManager.findFreePort()).toBe(8082);
 * ```
 *
 * @example Exhausted ports throw error
 * ```ts
 * const portManager = createPortManagerMock([8080]);
 * await portManager.findFreePort(); // 8080
 * await expect(portManager.findFreePort()).rejects.toThrow("No ports available");
 * ```
 *
 * @example State inspection
 * ```ts
 * const portManager = createPortManagerMock([8080, 8081]);
 * await portManager.findFreePort();
 * expect(portManager.$.remainingPorts).toEqual([8081]);
 * expect(portManager.$.allocatedPorts).toEqual([8080]);
 * ```
 *
 * @example Snapshot comparison
 * ```ts
 * const portManager = createPortManagerMock([8080, 8081]);
 * const before = portManager.$.snapshot();
 * await portManager.findFreePort();
 * expect(portManager).not.toBeUnchanged(before);
 * ```
 *
 * @example Configure unavailable ports for isPortAvailable
 * ```ts
 * const portManager = createPortManagerMock({ ports: [8080], unavailablePorts: [25448] });
 * expect(await portManager.isPortAvailable(25448)).toBe(false);
 * expect(await portManager.isPortAvailable(8080)).toBe(true);
 * ```
 */
export function createPortManagerMock(
  portsOrOptions: readonly number[] | PortManagerMockOptions = [8080]
): MockPortManager {
  // Type guard: if it's an array, wrap it in options object
  const isPortsArray = (
    val: readonly number[] | PortManagerMockOptions
  ): val is readonly number[] => Array.isArray(val);

  const options: PortManagerMockOptions = isPortsArray(portsOrOptions)
    ? { ports: portsOrOptions }
    : portsOrOptions;

  const ports = options.ports ?? [8080];
  const unavailablePorts = options.unavailablePorts ?? [];

  const state = new PortManagerMockState(ports, unavailablePorts);

  return {
    $: state,
    async findFreePort(): Promise<number> {
      return state.allocateNext();
    },
    async isPortAvailable(port: number): Promise<boolean> {
      return state.checkPortAvailable(port);
    },
  };
}
