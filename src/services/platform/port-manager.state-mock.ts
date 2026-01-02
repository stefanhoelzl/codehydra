/**
 * Behavioral state mock for PortManager.
 *
 * Provides a sequential port allocation mock that follows the
 * `MockWithState<T>` pattern from `src/test/state-mock.ts`.
 */

import type { PortManager } from "./network";
import type { MockState, MockWithState, Snapshot } from "../../test/state-mock";

/**
 * State for the PortManager mock.
 * Tracks remaining ports to allocate and ports already allocated.
 */
export class PortManagerMockState implements MockState {
  private _remainingPorts: number[];
  private _allocatedPorts: number[] = [];

  constructor(ports: readonly number[]) {
    this._remainingPorts = [...ports];
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

  snapshot(): Snapshot {
    return {
      __brand: "Snapshot",
      value: this.toString(),
    };
  }

  toString(): string {
    return `PortManagerMockState { remaining: [${this._remainingPorts.join(", ")}], allocated: [${this._allocatedPorts.join(", ")}] }`;
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
 * @param ports - Array of ports to return sequentially. Default: `[8080]`
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
 */
export function createPortManagerMock(ports: readonly number[] = [8080]): MockPortManager {
  const state = new PortManagerMockState(ports);

  return {
    $: state,
    async findFreePort(): Promise<number> {
      return state.allocateNext();
    },
  };
}
