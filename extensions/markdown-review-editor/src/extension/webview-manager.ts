/**
 * Shared webview utilities for both Virtual and File document modes.
 * Contains common webview creation, HTML generation, and message handling.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createSession, sendPrompt } from './opencode-handler';
import type {
	WebviewToExtensionMessage,
	ExtensionToWebviewMessage,
	DocumentMode,
	AnnotationContent
} from './message-types';
import { logger } from './logger';
import { serializeDocument } from '../lib/utils/document-storage';

// Track active prompt requests for cancellation support
const activeRequests = new Map<string, AbortController>();

/**
 * Generate a random nonce for CSP.
 */
export function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/**
 * Read the webview assets (JS and CSS) from disk.
 */
function readWebviewAssets(extensionUri: vscode.Uri): { jsCode: string; cssCode: string } {
	const jsPath = path.join(extensionUri.fsPath, 'dist', 'webview', 'index.js');
	const cssPath = path.join(extensionUri.fsPath, 'dist', 'webview', 'index.css');

	let jsCode: string;
	let cssCode: string;

	try {
		jsCode = fs.readFileSync(jsPath, 'utf-8');
		cssCode = fs.readFileSync(cssPath, 'utf-8');
	} catch {
		throw new Error('Webview assets not found. Run "npm run build:webview" to build the webview.');
	}

	return { jsCode, cssCode };
}

// Cached webview assets (JS and CSS code)
let cachedAssets: { jsCode: string; cssCode: string } | null = null;

/**
 * Generate the webview HTML content with inlined JS and CSS.
 * Assets are cached after first read for performance.
 */
export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	// Load and cache assets
	if (cachedAssets === null) {
		cachedAssets = readWebviewAssets(extensionUri);
		logger.debug('Webview assets loaded and cached');
	}

	const { jsCode, cssCode }: { jsCode: string; cssCode: string } = cachedAssets;

	// Use a nonce for Content Security Policy (must be unique per webview)
	const nonce = getNonce();

	// CSP: script-src uses nonce only (no external sources needed since JS is inlined)
	// style-src uses 'unsafe-inline' for inlined CSS
	// font-src uses webview.cspSource for any fonts the CSS might reference
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
	<style>${cssCode}</style>
	<title>Markdown Review Editor</title>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}">${jsCode}</script>
</body>
</html>`;
}

/**
 * Send current theme to webview.
 */
export function sendThemeToWebview(webview: vscode.Webview, requestId?: string): void {
	const currentTheme = vscode.window.activeColorTheme;
	const themeKind = currentTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
	logger.debug(`Sending theme: kind=${themeKind}`);
	webview.postMessage({
		type: 'themeChanged',
		kind: themeKind,
		requestId
	} as ExtensionToWebviewMessage);
}

/**
 * Send initial content to webview.
 */
export function sendInitialContent(
	webview: vscode.Webview,
	content: string,
	annotations: AnnotationContent[],
	mode: DocumentMode,
	fileName?: string
): void {
	logger.debug(`Sending initial content: mode=${mode}, fileName=${fileName}`);
	webview.postMessage({
		type: 'initialContent',
		content,
		annotations,
		mode,
		fileName
	} as ExtensionToWebviewMessage);
}

/**
 * Callback interface for document-specific message handling.
 */
export interface DocumentMessageHandler {
	/** Called when content changes in webview */
	onDocumentChanged?: (content: string, annotations: AnnotationContent[]) => void;
	/** Called when Save As is requested */
	onSaveAs?: (
		content: string,
		annotations: AnnotationContent[],
		requestId: string
	) => Promise<void>;
	/** Called when reload from disk is requested (file mode only) */
	onReloadFromDisk?: (requestId: string) => Promise<void>;
	/** Called when apply comments completes (for persistence trigger) */
	onApplyComplete?: () => void;
}

/**
 * Create a message handler for the webview.
 * Handles common messages and delegates document-specific messages to the handler.
 */
export function createMessageHandler(
	webview: vscode.Webview,
	documentHandler: DocumentMessageHandler
): (message: WebviewToExtensionMessage) => Promise<void> {
	return async (message: WebviewToExtensionMessage): Promise<void> => {
		// Don't log 'log' messages to avoid duplicate logging
		if (message.type !== 'log') {
			logger.debug(`Received message from webview: type=${message.type}`);
		}

		switch (message.type) {
			case 'createSession': {
				logger.info(`Creating OpenCode session: title="${message.title}"`);

				// Create or reuse abort controller for this request
				// This allows the same requestId to be used for both createSession and sendPrompt
				let controller = activeRequests.get(message.requestId);
				if (!controller) {
					controller = new AbortController();
					activeRequests.set(message.requestId, controller);
				}

				const result = await createSession(message.title, {
					signal: controller.signal
				});

				if (result.error) {
					logger.error(`Failed to create session: ${result.error}`);
					// Clean up on error (no sendPrompt will follow)
					activeRequests.delete(message.requestId);
				} else {
					logger.info(`Session created: sessionId=${result.sessionId}`);
					// Keep the controller - sendPrompt will reuse it
				}
				webview.postMessage({
					type: 'sessionCreated',
					requestId: message.requestId,
					sessionId: result.sessionId,
					error: result.error
				} as ExtensionToWebviewMessage);
				break;
			}

			case 'sendPrompt': {
				logger.info(
					`Sending prompt to OpenCode: sessionId=${message.sessionId}, promptLength=${message.prompt.length}`
				);

				// Reuse existing abort controller (created during createSession) or create new one
				let controller = activeRequests.get(message.requestId);
				if (!controller) {
					controller = new AbortController();
					activeRequests.set(message.requestId, controller);
				}

				const result = await sendPrompt(message.sessionId, message.prompt, {
					onProgress: (wordCount) => {
						webview.postMessage({
							type: 'promptProgress',
							requestId: message.requestId,
							wordCount
						} as ExtensionToWebviewMessage);
					},
					signal: controller.signal
				});

				// Clean up the request (this is the final operation for this requestId)
				activeRequests.delete(message.requestId);

				webview.postMessage({
					type: 'promptResponse',
					requestId: message.requestId,
					response: result.response,
					error: result.error
				} as ExtensionToWebviewMessage);
				// Trigger persistence after apply completes
				documentHandler.onApplyComplete?.();
				break;
			}

			case 'abortPrompt': {
				const controller = activeRequests.get(message.requestId);
				if (controller) {
					controller.abort();
					activeRequests.delete(message.requestId);
				}
				break;
			}

			case 'getTheme': {
				sendThemeToWebview(webview, message.requestId);
				break;
			}

			case 'documentChanged': {
				documentHandler.onDocumentChanged?.(message.content, message.annotations);
				break;
			}

			case 'saveAs': {
				if (documentHandler.onSaveAs) {
					await documentHandler.onSaveAs(message.content, message.annotations, message.requestId);
				} else {
					webview.postMessage({
						type: 'saveAsResult',
						requestId: message.requestId,
						success: false,
						error: 'Save As not supported in this mode'
					} as ExtensionToWebviewMessage);
				}
				break;
			}

			case 'reloadFromDisk': {
				if (documentHandler.onReloadFromDisk) {
					await documentHandler.onReloadFromDisk(message.requestId);
				}
				break;
			}

			case 'log': {
				// Forward webview logs to our logger
				const logMessage = `[Webview] ${message.message}`;
				const dataStr = message.data !== undefined ? ` ${JSON.stringify(message.data)}` : '';
				switch (message.level) {
					case 'error':
						logger.error(`${logMessage}${dataStr}`);
						break;
					case 'warn':
						logger.warn(`${logMessage}${dataStr}`);
						break;
					default:
						logger.info(`${logMessage}${dataStr}`);
				}
				break;
			}
		}
	};
}

/**
 * Handle Save As operation (shared by both modes).
 */
export async function handleSaveAs(
	webview: vscode.Webview,
	content: string,
	annotations: AnnotationContent[],
	requestId: string
): Promise<vscode.Uri | undefined> {
	logger.info('Save As requested');
	try {
		const uri = await vscode.window.showSaveDialog({
			filters: { Markdown: ['md', 'markdown'] },
			defaultUri: vscode.Uri.file('document.md')
		});

		if (uri) {
			logger.info(`Saving document: path=${uri.fsPath}`);
			const serialized = serializeDocument(content, annotations);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(serialized, 'utf-8'));
			logger.info('Document saved successfully');

			webview.postMessage({
				type: 'saveAsResult',
				requestId,
				success: true,
				filePath: uri.fsPath
			} as ExtensionToWebviewMessage);

			return uri;
		} else {
			logger.debug('Save As cancelled by user');
			webview.postMessage({
				type: 'saveAsResult',
				requestId,
				success: false,
				error: 'Save cancelled'
			} as ExtensionToWebviewMessage);
			return undefined;
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		logger.error(`Failed to save document: ${errorMsg}`);
		webview.postMessage({
			type: 'saveAsResult',
			requestId,
			success: false,
			error: errorMsg
		} as ExtensionToWebviewMessage);
		return undefined;
	}
}
