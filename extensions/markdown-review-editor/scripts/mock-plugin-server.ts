/**
 * Mock PluginServer for debugging the markdown-review-editor extension.
 *
 * This script starts a Socket.IO server that mimics CodeHydra's PluginServer,
 * allowing the sidekick extension to connect and provide the CodeHydra API
 * to other extensions like markdown-review-editor.
 *
 * Usage:
 *   npx tsx scripts/mock-plugin-server.ts [--port=PORT]
 *
 * Environment Variables:
 *   MOCK_PLUGIN_PORT - Port to listen on (default: 51200)
 *   MOCK_OPENCODE_PORT - OpenCode port to report (default: 51201)
 */

import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const DEFAULT_PLUGIN_PORT = 51200;
const DEFAULT_OPENCODE_PORT = 51201;
const LOG_FILE = path.join(process.cwd(), 'mock-server.log');

// Parse command line arguments
const args = process.argv.slice(2);
let pluginPort = DEFAULT_PLUGIN_PORT;
let opencodePort = DEFAULT_OPENCODE_PORT;

for (const arg of args) {
	if (arg.startsWith('--port=')) {
		pluginPort = parseInt(arg.slice(7), 10);
	} else if (arg.startsWith('--opencode-port=')) {
		opencodePort = parseInt(arg.slice(16), 10);
	}
}

// Override from environment
if (process.env.MOCK_PLUGIN_PORT) {
	pluginPort = parseInt(process.env.MOCK_PLUGIN_PORT, 10);
}
if (process.env.MOCK_OPENCODE_PORT) {
	opencodePort = parseInt(process.env.MOCK_OPENCODE_PORT, 10);
}

// Types matching sidekick extension's expectations
interface PluginResult<T = unknown> {
	readonly success: true;
	readonly data: T;
}

interface PluginResultError {
	readonly success: false;
	readonly error: string;
}

type Result<T> = PluginResult<T> | PluginResultError;

interface SetMetadataRequest {
	readonly key: string;
	readonly value: string | null;
}

interface LogRequest {
	readonly level: 'silly' | 'debug' | 'info' | 'warn' | 'error';
	readonly message: string;
	readonly context?: Record<string, string | number | boolean | null>;
}

interface WorkspaceCreateRequest {
	readonly name: string;
	readonly base: string;
	readonly initialPrompt?: string | { prompt: string; agent?: string };
	readonly keepInBackground?: boolean;
}

interface CommandRequest {
	readonly command: string;
	readonly args?: readonly unknown[];
}

// Mock state
interface WorkspaceMetadata {
	[key: string]: string;
}

const metadata: WorkspaceMetadata = {
	base: 'main'
};

// Logging utility
function log(level: string, message: string, context?: object): void {
	const timestamp = new Date().toISOString();
	const contextStr = context ? ` ${JSON.stringify(context)}` : '';
	const logLine = `[${timestamp}] [${level}] ${message}${contextStr}\n`;
	process.stdout.write(logLine);
	fs.appendFileSync(LOG_FILE, logLine);
}

// Clear log file on start
fs.writeFileSync(LOG_FILE, '');

// Create HTTP server and Socket.IO instance
const httpServer = createServer();
const io = new Server(httpServer, {
	transports: ['websocket'],
	cors: {
		origin: '*'
	}
});

log('info', `Starting Mock PluginServer on port ${pluginPort}`);
log('info', `Mock OpenCode port: ${opencodePort}`);

io.on('connection', (socket: Socket) => {
	const workspacePath = socket.handshake.auth.workspacePath as string;
	log('info', 'Client connected', { workspacePath, socketId: socket.id });

	// Send config event immediately after connection
	socket.emit('config', { isDevelopment: true });
	log('debug', 'Sent config to client', { isDevelopment: true });

	// Handle workspace status request
	socket.on(
		'api:workspace:getStatus',
		(ack: (result: Result<{ isDirty: boolean; agent: { type: string } }>) => void) => {
			log('debug', 'Handling getStatus');
			ack({
				success: true,
				data: {
					isDirty: false,
					agent: { type: 'none' }
				}
			});
		}
	);

	// Handle OpenCode session request
	socket.on(
		'api:workspace:getOpenCodeSession',
		(ack: (result: Result<{ port: number; sessionId: string } | null>) => void) => {
			log('debug', 'Handling getOpenCodeSession');
			ack({
				success: true,
				data: {
					port: opencodePort,
					sessionId: 'mock-session-' + Date.now()
				}
			});
		}
	);

	// Handle restart OpenCode server request
	socket.on('api:workspace:restartOpencodeServer', (ack: (result: Result<number>) => void) => {
		log('debug', 'Handling restartOpencodeServer');
		ack({
			success: true,
			data: opencodePort
		});
	});

	// Handle metadata get request
	socket.on(
		'api:workspace:getMetadata',
		(ack: (result: Result<Record<string, string>>) => void) => {
			log('debug', 'Handling getMetadata');
			ack({
				success: true,
				data: { ...metadata }
			});
		}
	);

	// Handle metadata set request
	socket.on(
		'api:workspace:setMetadata',
		(request: SetMetadataRequest, ack: (result: Result<void>) => void) => {
			log('debug', 'Handling setMetadata', { key: request.key, value: request.value });
			if (request.value === null) {
				delete metadata[request.key];
			} else {
				metadata[request.key] = request.value;
			}
			ack({ success: true, data: undefined });
		}
	);

	// Handle execute command request
	socket.on(
		'api:workspace:executeCommand',
		(request: CommandRequest, ack: (result: Result<unknown>) => void) => {
			log('debug', 'Handling executeCommand', { command: request.command, args: request.args });
			// Just acknowledge - we can't execute VS Code commands from here
			ack({ success: true, data: undefined });
		}
	);

	// Handle workspace create request
	socket.on(
		'api:workspace:create',
		(
			request: WorkspaceCreateRequest,
			ack: (result: Result<{ name: string; path: string; base: string }>) => void
		) => {
			log('debug', 'Handling workspace create', { name: request.name, base: request.base });
			// Return mock workspace
			ack({
				success: true,
				data: {
					name: request.name,
					path: `/mock/workspaces/${request.name}`,
					base: request.base
				}
			});
		}
	);

	// Handle log requests (fire and forget, no ack)
	socket.on('api:log', (request: LogRequest) => {
		log(request.level, `[extension] ${request.message}`, request.context);
	});

	// Handle disconnection
	socket.on('disconnect', (reason) => {
		log('info', 'Client disconnected', { socketId: socket.id, reason });
	});
});

// Start the server
httpServer.listen(pluginPort, '127.0.0.1', () => {
	log('info', `Mock PluginServer listening on http://127.0.0.1:${pluginPort}`);
	log('info', 'Waiting for sidekick extension to connect...');
	log('info', `Set CODEHYDRA_PLUGIN_PORT=${pluginPort} in your VS Code launch config`);
});

// Handle shutdown
process.on('SIGINT', () => {
	log('info', 'Shutting down...');
	io.close();
	httpServer.close();
	process.exit(0);
});

process.on('SIGTERM', () => {
	log('info', 'Shutting down...');
	io.close();
	httpServer.close();
	process.exit(0);
});
