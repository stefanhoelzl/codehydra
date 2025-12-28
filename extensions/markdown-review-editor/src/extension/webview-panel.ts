/**
 * Webview panel management for MarkdownReviewEditor.
 *
 * This file is now a thin wrapper that delegates to VirtualDocumentProvider.
 * Kept for backwards compatibility during migration.
 *
 * @deprecated Use VirtualDocumentProvider directly instead.
 */

import * as vscode from 'vscode';
import { VirtualDocumentProvider } from './virtual-document-provider';

let virtualProvider: VirtualDocumentProvider | undefined;

/**
 * Get the current webview panel instance.
 * @deprecated Access via VirtualDocumentProvider.getPanel() instead.
 */
export function getWebviewPanel(): vscode.WebviewPanel | undefined {
	return virtualProvider?.getPanel();
}

/**
 * Create or show the webview panel.
 * @deprecated Use VirtualDocumentProvider.openEditor() instead.
 */
export function createWebviewPanel(context: vscode.ExtensionContext): void {
	if (!virtualProvider) {
		virtualProvider = new VirtualDocumentProvider(context);
	}
	virtualProvider.openEditor();
}

/**
 * Get the virtual document provider instance.
 */
export function getVirtualProvider(): VirtualDocumentProvider | undefined {
	return virtualProvider;
}

/**
 * Initialize the virtual provider (called from extension.ts).
 */
export function initVirtualProvider(context: vscode.ExtensionContext): VirtualDocumentProvider {
	if (!virtualProvider) {
		virtualProvider = new VirtualDocumentProvider(context);
		context.subscriptions.push(virtualProvider);
	}
	return virtualProvider;
}
