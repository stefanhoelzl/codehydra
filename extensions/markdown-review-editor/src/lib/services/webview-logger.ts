/**
 * Logger for webview code that forwards logs to the extension host.
 * Logs are sent via postMessage and written to server.log by the extension.
 */

import { getVsCodeApi } from './opencode-client';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Format data for single-line log output.
 */
function formatData(data: unknown): string {
	if (data === undefined) return '';
	try {
		if (typeof data === 'string') return data;
		return JSON.stringify(data);
	} catch {
		return '[Unable to serialize data]';
	}
}

/**
 * Send a log message to the extension host.
 */
function log(level: LogLevel, message: string, data?: unknown): void {
	const dataStr = data !== undefined ? ` ${formatData(data)}` : '';
	const fullMessage = `${message}${dataStr}`;

	// Also log to browser console for debugging
	const consoleMethod = level === 'debug' ? 'log' : level;
	console[consoleMethod](`[${level.toUpperCase()}]`, fullMessage);

	// Forward to extension host
	try {
		getVsCodeApi().postMessage({
			type: 'log',
			level: level === 'debug' ? 'info' : level,
			message: `[${level.toUpperCase()}] ${fullMessage}`,
			data: undefined // Don't send data separately, it's already in the message
		});
	} catch {
		// Silently fail if VS Code API is not available (e.g., in tests)
	}
}

/**
 * Webview logger that forwards all logs to the extension host.
 */
export const webviewLogger = {
	debug: (message: string, data?: unknown) => log('debug', message, data),
	info: (message: string, data?: unknown) => log('info', message, data),
	warn: (message: string, data?: unknown) => log('warn', message, data),
	error: (message: string, data?: unknown) => log('error', message, data)
};
