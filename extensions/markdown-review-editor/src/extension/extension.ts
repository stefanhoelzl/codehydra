/**
 * VS Code Extension entry point for MarkdownReviewEditor.
 *
 * Supports two modes:
 * - Virtual Mode: Command-based editor with workspace state persistence
 * - File Mode: Custom editor for .md files (registered via package.json)
 */

import * as vscode from 'vscode';
import { VirtualDocumentProvider } from './virtual-document-provider';
import { MarkdownReviewEditorProvider } from './custom-editor-provider';
import { initLogger, logger } from './logger';
import { initializeOpencodePort, resetOpencodeHandler } from './opencode-handler';

/**
 * Minimal type for the CodeHydra sidekick extension API.
 * Only includes the methods we need.
 */
interface OpenCodeSession {
	port: number;
	sessionId: string;
}

interface CodehydraApi {
	whenReady(): Promise<void>;
	workspace: {
		getOpenCodeSession(): Promise<OpenCodeSession | null>;
	};
}

let virtualProvider: VirtualDocumentProvider | undefined;

/**
 * Initialize the OpenCode connection by getting the port from the sidekick extension.
 * This is done asynchronously after extension activation.
 */
async function initializeOpencode(): Promise<void> {
	try {
		const sidekickExt = vscode.extensions.getExtension('codehydra.sidekick');
		if (!sidekickExt) {
			logger.warn('CodeHydra sidekick extension not found - OpenCode features will be unavailable');
			return;
		}

		// Ensure the extension is activated
		if (!sidekickExt.isActive) {
			logger.debug('Activating CodeHydra sidekick extension...');
			await sidekickExt.activate();
		}

		const api = sidekickExt.exports?.codehydra as CodehydraApi | undefined;
		if (!api) {
			logger.warn(
				'CodeHydra sidekick extension API not available - OpenCode features will be unavailable'
			);
			return;
		}

		// Wait for sidekick to be connected to CodeHydra
		logger.debug('Waiting for CodeHydra sidekick to be ready...');
		await api.whenReady();

		// Get the OpenCode session
		const session = await api.workspace.getOpenCodeSession();
		if (session === null) {
			logger.warn('OpenCode server not running - OpenCode features will be unavailable');
			return;
		}

		// Initialize the opencode handler with the port
		initializeOpencodePort(session.port);
		logger.info(`OpenCode initialized successfully on port ${session.port}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to initialize OpenCode: ${message}`);
	}
}

export function activate(context: vscode.ExtensionContext) {
	// Initialize logging first
	initLogger(context);

	logger.info('MarkdownReviewEditor extension is now active');

	// Initialize OpenCode connection asynchronously (don't block activation)
	void initializeOpencode();

	// Register Custom Editor Provider for .md files (File Mode)
	context.subscriptions.push(MarkdownReviewEditorProvider.register(context));

	// Initialize Virtual Document Provider
	virtualProvider = new VirtualDocumentProvider(context);
	context.subscriptions.push(virtualProvider);

	// Register command to open virtual document editor
	const openCommand = vscode.commands.registerCommand('markdownReviewEditor.open', () => {
		logger.info('Opening Markdown Review Editor (virtual mode)');
		virtualProvider!.openEditor();
	});
	context.subscriptions.push(openCommand);

	// Listen for theme changes and notify all open webviews
	const themeDisposable = vscode.window.onDidChangeActiveColorTheme((theme) => {
		const themeKind = theme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
		logger.debug(`Theme changed to: ${themeKind}`);

		// Notify virtual panel if open
		const virtualPanel = virtualProvider?.getPanel();
		if (virtualPanel) {
			virtualPanel.webview.postMessage({
				type: 'themeChanged',
				kind: themeKind
			});
		}

		// Note: Custom editor panels are notified via their own subscription
		// in MarkdownReviewEditorProvider
	});
	context.subscriptions.push(themeDisposable);
}

export async function deactivate() {
	// Save virtual document state before extension closes
	if (virtualProvider) {
		await virtualProvider.saveCurrentState();
	}

	// Reset OpenCode handler
	resetOpencodeHandler();

	logger.info('MarkdownReviewEditor extension is deactivating');
}
