/**
 * Custom Editor Provider for file-bound markdown documents.
 *
 * Provides a custom editor for .md files that integrates with VS Code's
 * save/revert/dirty state mechanisms.
 */

import * as vscode from 'vscode';
import type { AnnotationContent, WebviewToExtensionMessage } from './message-types';
import { serializeDocument, deserializeDocument } from '../lib/utils/document-storage';
import {
	getWebviewContent,
	sendThemeToWebview,
	sendInitialContent,
	createMessageHandler,
	handleSaveAs
} from './webview-manager';
import { logger } from './logger';

const VIEW_TYPE = 'markdownReviewEditor.editor';

/**
 * Custom document for markdown review files.
 */
class MarkdownReviewDocument implements vscode.CustomDocument {
	private _html: string;
	private _annotations: AnnotationContent[];
	private _savedHtml: string;
	private _savedAnnotations: AnnotationContent[];

	private readonly _onDidChange = new vscode.EventEmitter<{
		readonly content?: { html: string; annotations: AnnotationContent[] };
		readonly edits?: readonly unknown[];
	}>();
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidChangeContent = new vscode.EventEmitter<void>();
	readonly onDidChangeContent = this._onDidChangeContent.event;

	constructor(
		readonly uri: vscode.Uri,
		html: string,
		annotations: AnnotationContent[]
	) {
		this._html = html;
		this._annotations = annotations;
		this._savedHtml = html;
		this._savedAnnotations = [...annotations];
	}

	get html(): string {
		return this._html;
	}

	get annotations(): AnnotationContent[] {
		return this._annotations;
	}

	get fileName(): string {
		return this.uri.path.split('/').pop() || 'document.md';
	}

	/**
	 * Update document content (called when webview changes).
	 */
	updateContent(html: string, annotations: AnnotationContent[]): void {
		this._html = html;
		this._annotations = annotations;
		this._onDidChange.fire({ content: { html, annotations } });
		this._onDidChangeContent.fire();
	}

	/**
	 * Mark the document as saved.
	 */
	markSaved(): void {
		this._savedHtml = this._html;
		this._savedAnnotations = [...this._annotations];
	}

	/**
	 * Revert to last saved state.
	 */
	revertToSaved(): { html: string; annotations: AnnotationContent[] } {
		this._html = this._savedHtml;
		this._annotations = [...this._savedAnnotations];
		return { html: this._html, annotations: this._annotations };
	}

	/**
	 * Reload content from disk.
	 */
	async reloadFromDisk(): Promise<{ html: string; annotations: AnnotationContent[] }> {
		const content = await vscode.workspace.fs.readFile(this.uri);
		const text = Buffer.from(content).toString('utf-8');
		const { documentHtml, annotations } = deserializeDocument(text);

		this._html = documentHtml;
		this._annotations = annotations;
		this._savedHtml = documentHtml;
		this._savedAnnotations = [...annotations];

		return { html: documentHtml, annotations };
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._onDidChangeContent.dispose();
	}
}

/**
 * Custom Editor Provider for Markdown Review files.
 */
export class MarkdownReviewEditorProvider implements vscode.CustomEditorProvider<MarkdownReviewDocument> {
	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
		vscode.CustomDocumentEditEvent<MarkdownReviewDocument>
	>();
	readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	private readonly webviewPanels = new Map<MarkdownReviewDocument, vscode.WebviewPanel>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	/**
	 * Register this provider with VS Code.
	 */
	static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new MarkdownReviewEditorProvider(context);
		return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: false
		});
	}

	// ========================================
	// CustomEditorProvider implementation
	// ========================================

	async openCustomDocument(
		uri: vscode.Uri,
		_openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken
	): Promise<MarkdownReviewDocument> {
		logger.info(`Opening custom document: ${uri.fsPath}`);

		const content = await vscode.workspace.fs.readFile(uri);
		const text = Buffer.from(content).toString('utf-8');
		const { documentHtml, annotations } = deserializeDocument(text);

		const document = new MarkdownReviewDocument(uri, documentHtml, annotations);

		// Listen for document changes to fire edit events
		document.onDidChange((e) => {
			if (e.content) {
				this._onDidChangeCustomDocument.fire({
					document,
					undo: async () => {
						// Simple undo: revert to saved state
						// For full undo support, we'd need to track edit history
					},
					redo: async () => {
						// Simple redo
					}
				});
			}
		});

		return document;
	}

	async resolveCustomEditor(
		document: MarkdownReviewDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		logger.info(`Resolving custom editor for: ${document.uri.fsPath}`);

		// Store panel reference
		this.webviewPanels.set(document, webviewPanel);

		// Configure webview
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')]
		};

		// Set webview HTML content
		webviewPanel.webview.html = getWebviewContent(webviewPanel.webview, this.context.extensionUri);

		// Setup message handler
		const messageHandler = createMessageHandler(webviewPanel.webview, {
			onDocumentChanged: (html, annotations) => {
				document.updateContent(html, annotations);
			},
			onSaveAs: async (html, annotations, requestId) => {
				await handleSaveAs(webviewPanel.webview, html, annotations, requestId);
			},
			onReloadFromDisk: async (requestId) => {
				const { html, annotations } = await document.reloadFromDisk();
				webviewPanel.webview.postMessage({
					type: 'contentReloaded',
					requestId,
					content: html,
					annotations
				});
			}
		});

		webviewPanel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) =>
			messageHandler(message)
		);

		// Send initial theme
		sendThemeToWebview(webviewPanel.webview);

		// Send initial content after a short delay to ensure webview is ready
		setTimeout(() => {
			sendInitialContent(
				webviewPanel.webview,
				document.html,
				document.annotations,
				'file',
				document.fileName
			);
		}, 100);

		// Listen for theme changes
		const themeDisposable = vscode.window.onDidChangeActiveColorTheme((theme) => {
			const themeKind = theme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
			webviewPanel.webview.postMessage({
				type: 'themeChanged',
				kind: themeKind
			});
		});

		// Cleanup on panel close
		webviewPanel.onDidDispose(() => {
			this.webviewPanels.delete(document);
			themeDisposable.dispose();
		});
	}

	async saveCustomDocument(
		document: MarkdownReviewDocument,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		if (cancellation.isCancellationRequested) return;

		logger.info(`Saving document: ${document.uri.fsPath}`);

		const serialized = serializeDocument(document.html, document.annotations);
		await vscode.workspace.fs.writeFile(document.uri, Buffer.from(serialized, 'utf-8'));

		document.markSaved();
		logger.info('Document saved successfully');
	}

	async saveCustomDocumentAs(
		document: MarkdownReviewDocument,
		destination: vscode.Uri,
		cancellation: vscode.CancellationToken
	): Promise<void> {
		if (cancellation.isCancellationRequested) return;

		logger.info(`Saving document as: ${destination.fsPath}`);

		const serialized = serializeDocument(document.html, document.annotations);
		await vscode.workspace.fs.writeFile(destination, Buffer.from(serialized, 'utf-8'));

		logger.info('Document saved successfully');
	}

	async revertCustomDocument(
		document: MarkdownReviewDocument,
		_cancellation: vscode.CancellationToken
	): Promise<void> {
		logger.info(`Reverting document: ${document.uri.fsPath}`);

		const { html, annotations } = await document.reloadFromDisk();

		// Notify webview of reverted content
		const panel = this.webviewPanels.get(document);
		if (panel) {
			sendInitialContent(panel.webview, html, annotations, 'file', document.fileName);
		}
	}

	async backupCustomDocument(
		document: MarkdownReviewDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken
	): Promise<vscode.CustomDocumentBackup> {
		logger.debug(`Creating backup for: ${document.uri.fsPath}`);

		// Serialize and save to backup location
		const serialized = serializeDocument(document.html, document.annotations);
		await vscode.workspace.fs.writeFile(context.destination, Buffer.from(serialized, 'utf-8'));

		return {
			id: context.destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(context.destination);
				} catch {
					// Ignore deletion errors
				}
			}
		};
	}
}
