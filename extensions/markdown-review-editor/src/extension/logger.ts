/**
 * Logging utility for the extension.
 * Writes to both VS Code OutputChannel and a file (server.log).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let outputChannel: vscode.OutputChannel | null = null;
let logFilePath: string | null = null;

/**
 * Initialize the logger.
 * Call this once in activate().
 */
export function initLogger(context: vscode.ExtensionContext): void {
	// Create VS Code output channel
	outputChannel = vscode.window.createOutputChannel('Markdown Review Editor');
	context.subscriptions.push(outputChannel);

	// Determine log file path (workspace folder or extension path)
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const basePath = workspaceFolder || context.extensionPath;
	logFilePath = path.join(basePath, 'server.log');

	// Clear and initialize log file
	try {
		fs.writeFileSync(logFilePath, '');
		log('INFO', `Logger initialized. Log file: ${logFilePath}`);
		log('INFO', `Extension path: ${context.extensionPath}`);
		log('INFO', `Workspace: ${workspaceFolder || 'none'}`);
	} catch (err) {
		outputChannel.appendLine(`[ERROR] Failed to create log file: ${err}`);
		logFilePath = null;
	}
}

/**
 * Log a message with the specified level.
 * All log messages are single-line.
 */
export function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void {
	const timestamp = new Date().toISOString();
	const fullMessage = `[${timestamp}] [${level}] ${message}`;

	// Write to OutputChannel
	if (outputChannel) {
		outputChannel.appendLine(fullMessage);
	}

	// Write to file
	if (logFilePath) {
		try {
			fs.appendFileSync(logFilePath, fullMessage + '\n');
		} catch {
			// Silently fail file writes
		}
	}
}

/**
 * Convenience methods
 */
export const logger = {
	info: (message: string) => log('INFO', message),
	warn: (message: string) => log('WARN', message),
	error: (message: string) => log('ERROR', message),
	debug: (message: string) => log('DEBUG', message)
};

/**
 * Show the output channel in VS Code.
 */
export function showLog(): void {
	outputChannel?.show();
}
