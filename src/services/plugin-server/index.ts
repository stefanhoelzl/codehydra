/**
 * Plugin server module - Socket.IO server for VS Code extension communication.
 */

export { PluginServer, type ApiCallHandlers } from "./plugin-server";
export { SHUTDOWN_DISCONNECT_TIMEOUT_MS } from "../../shared/plugin-protocol";
