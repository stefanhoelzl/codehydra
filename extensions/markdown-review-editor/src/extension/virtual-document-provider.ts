/**
 * Virtual Document Provider for MarkdownReviewEditor.
 * Manages a single virtual document that persists to workspace state.
 *
 * Persistence triggers:
 * - Panel hidden (user switches tabs)
 * - Panel disposed (user closes editor)
 * - Apply Comments completes
 * - Extension deactivates (VS Code closes)
 */

import * as vscode from 'vscode';
import type { AnnotationContent, WebviewToExtensionMessage } from './message-types';
import { getDemoMarkdown, getDemoAnnotations } from './demo-content';
import { annotated_md2html } from '../lib/utils/html-to-markdown';
import {
	getWebviewContent,
	sendThemeToWebview,
	sendInitialContent,
	createMessageHandler,
	handleSaveAs
} from './webview-manager';
import { logger } from './logger';

const VIEW_TYPE = 'markdownReviewEditor.virtual';
const STORAGE_KEY = 'markdownReviewEditor.virtualDocument';

interface StoredDocument {
	html: string;
	annotations: AnnotationContent[];
}

export class VirtualDocumentProvider implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private currentContent: StoredDocument | undefined;
	private disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {}

	/**
	 * Open or reveal the virtual document editor.
	 */
	async openEditor(): Promise<void> {
		// If panel already exists, reveal it
		if (this.panel) {
			logger.debug('Virtual panel already exists, revealing');
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		logger.info('Creating virtual document panel');

		// Load initial content
		const content = await this.getInitialContent();
		this.currentContent = content;

		// Create panel
		this.panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			'Markdown Review Editor',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
			}
		);

		// Set webview content
		this.panel.webview.html = getWebviewContent(this.panel.webview, this.context.extensionUri);
		logger.debug('Webview HTML content set');

		// Setup message handler
		const messageHandler = createMessageHandler(this.panel.webview, {
			onDocumentChanged: (html, annotations) => {
				this.currentContent = { html, annotations };
				logger.debug('Virtual document content updated in memory');
			},
			onSaveAs: async (html, annotations, requestId) => {
				await handleSaveAs(this.panel!.webview, html, annotations, requestId);
			},
			onApplyComplete: () => {
				this.persistContent();
			}
		});

		this.panel.webview.onDidReceiveMessage(
			(message: WebviewToExtensionMessage) => messageHandler(message),
			undefined,
			this.disposables
		);

		// Send initial theme
		sendThemeToWebview(this.panel.webview);

		// Send initial content after a short delay to ensure webview is ready
		setTimeout(() => {
			if (this.panel) {
				sendInitialContent(this.panel.webview, content.html, content.annotations, 'virtual');
			}
		}, 100);

		// Handle visibility changes (save when hidden)
		this.panel.onDidChangeViewState(
			(e) => {
				if (!e.webviewPanel.visible) {
					logger.debug('Virtual panel hidden, persisting content');
					this.persistContent();
				}
			},
			null,
			this.disposables
		);

		// Handle panel dispose
		this.panel.onDidDispose(
			() => {
				logger.info('Virtual panel disposed, persisting content');
				this.persistContent();
				this.panel = undefined;
			},
			null,
			this.disposables
		);

		logger.info('Virtual document panel created successfully');
	}

	/**
	 * Get the current webview panel (if open).
	 */
	getPanel(): vscode.WebviewPanel | undefined {
		return this.panel;
	}

	/**
	 * Get initial content from workspace state or demo content.
	 */
	private async getInitialContent(): Promise<StoredDocument> {
		const stored = this.context.workspaceState.get<StoredDocument>(STORAGE_KEY);

		if (stored) {
			logger.info('Loaded virtual document from workspace state');
			return stored;
		}

		// First time: return demo content
		logger.info('No stored virtual document, loading demo content');
		const markdown = getDemoMarkdown();
		const html = annotated_md2html(markdown);
		const annotations = getDemoAnnotations();

		return { html, annotations };
	}

	/**
	 * Persist current content to workspace state.
	 */
	private async persistContent(): Promise<void> {
		if (this.currentContent) {
			await this.context.workspaceState.update(STORAGE_KEY, this.currentContent);
			logger.debug('Virtual document persisted to workspace state');
		}
	}

	/**
	 * Save current state (called on extension deactivate).
	 */
	async saveCurrentState(): Promise<void> {
		await this.persistContent();
	}

	/**
	 * Clear persisted content (reset to demo on next open).
	 */
	async clearPersistedContent(): Promise<void> {
		await this.context.workspaceState.update(STORAGE_KEY, undefined);
		logger.info('Virtual document cleared from workspace state');
	}

	/**
	 * Dispose of resources.
	 */
	dispose(): void {
		// Persist before disposing
		this.persistContent();

		// Dispose panel if open
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
		}

		// Dispose all subscriptions
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}
