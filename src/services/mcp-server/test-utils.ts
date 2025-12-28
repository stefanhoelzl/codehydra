/**
 * Test utilities for MCP Server tests.
 */

import { vi, type Mock } from "vitest";
import type { McpContext, McpResolvedWorkspace, McpToolResult, McpError } from "./types";
import type { ProjectId, WorkspaceName } from "../../shared/api/types";

// =============================================================================
// Mock MCP Server
// =============================================================================

/**
 * Mock implementation of IMcpServer for testing.
 */
export interface MockMcpServer {
  start: Mock<(port: number) => Promise<void>>;
  stop: Mock<() => Promise<void>>;
  dispose: Mock<() => Promise<void>>;
  isRunning: Mock<() => boolean>;
}

/**
 * Create a mock MCP server for testing.
 * @param overrides - Optional method overrides
 */
export function createMockMcpServer(overrides?: Partial<MockMcpServer>): MockMcpServer {
  return {
    start: vi.fn<(port: number) => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    dispose: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isRunning: vi.fn<() => boolean>().mockReturnValue(false),
    ...overrides,
  };
}

// =============================================================================
// Mock MCP Context
// =============================================================================

/**
 * Create a mock MCP context for testing.
 * @param workspacePath - Workspace path for the context
 * @param resolved - Optional resolved workspace (null if not found)
 */
export function createMockMcpContext(
  workspacePath: string,
  resolved?: McpResolvedWorkspace | null
): McpContext {
  return {
    workspacePath,
    resolved: resolved ?? null,
  };
}

/**
 * Create a resolved workspace for testing.
 * @param options - Workspace options
 */
export function createMockResolvedWorkspace(options: {
  projectId?: string;
  workspaceName?: string;
  workspacePath?: string;
}): McpResolvedWorkspace {
  return {
    projectId: (options.projectId ?? "test-project-12345678") as ProjectId,
    workspaceName: (options.workspaceName ?? "test-workspace") as WorkspaceName,
    workspacePath: options.workspacePath ?? "/path/to/workspace",
  };
}

// =============================================================================
// MCP Result Helpers
// =============================================================================

/**
 * Create a successful MCP tool result.
 */
export function createMcpSuccess<T>(data: T): McpToolResult<T> {
  return { success: true, data };
}

/**
 * Create a failed MCP tool result.
 */
export function createMcpError<T>(code: McpError["code"], message: string): McpToolResult<T> {
  return { success: false, error: { code, message } };
}

// =============================================================================
// Test MCP Client
// =============================================================================

/**
 * Options for test MCP client requests.
 */
export interface TestMcpClientOptions {
  /** X-Workspace-Path header value */
  workspacePath?: string;
  /** Request timeout in ms */
  timeout?: number;
}

/**
 * Test client for making MCP requests during boundary tests.
 */
export class TestMcpClient {
  private readonly baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /**
   * Call an MCP tool.
   * @param toolName - Name of the tool to call
   * @param args - Arguments to pass to the tool
   * @param options - Request options
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown> = {},
    options: TestMcpClientOptions = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.workspacePath) {
      headers["X-Workspace-Path"] = options.workspacePath;
    }

    const controller = new AbortController();
    const timeoutId = options.timeout
      ? setTimeout(() => controller.abort(), options.timeout)
      : null;

    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
          id: 1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Get the list of available tools.
   * @param options - Request options
   */
  async listTools(options: TestMcpClientOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.workspacePath) {
      headers["X-Workspace-Path"] = options.workspacePath;
    }

    const controller = new AbortController();
    const timeoutId = options.timeout
      ? setTimeout(() => controller.abort(), options.timeout)
      : null;

    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}

/**
 * Create a test MCP client for boundary tests.
 * @param port - Port the MCP server is running on
 */
export function createTestMcpClient(port: number): TestMcpClient {
  return new TestMcpClient(port);
}
