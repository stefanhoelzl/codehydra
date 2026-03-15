/**
 * MCP Server module exports.
 */

// Types
export type { McpErrorCode, McpError, IMcpServer, McpApiHandlers } from "./types";
export type { IDisposable } from "../../shared/types";

// MCP Server
export { McpServer, createDefaultMcpServer } from "./mcp-server";
export type { McpServerFactory } from "./mcp-server";

// McpServerManager is now inlined into src/modules/mcp-module.ts
