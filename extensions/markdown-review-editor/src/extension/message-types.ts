/**
 * Message types for communication between webview and extension host.
 * Supports both Virtual Document and File Document modes.
 */

import type { AnnotationContent } from '../lib/utils/annotation-types';

// Re-export AnnotationContent for convenience
export type { AnnotationContent };

// ============================================
// Common Types
// ============================================

export type DocumentMode = 'virtual' | 'file';

// ============================================
// Messages FROM webview TO extension host
// ============================================

export interface CreateSessionMessage {
	type: 'createSession';
	requestId: string;
	title: string;
}

export interface SendPromptMessage {
	type: 'sendPrompt';
	requestId: string;
	sessionId: string;
	prompt: string;
}

// Webview → Extension: Cancel ongoing request
export interface AbortPromptMessage {
	type: 'abortPrompt';
	requestId: string;
}

export interface GetThemeMessage {
	type: 'getTheme';
	requestId: string;
}

/** @deprecated Use documentChanged instead */
export interface SaveDocumentMessage {
	type: 'saveDocument';
	requestId: string;
	content: string;
	annotations: AnnotationContent[];
}

/** @deprecated No longer used */
export interface LoadDocumentMessage {
	type: 'loadDocument';
	requestId: string;
}

export interface LogMessage {
	type: 'log';
	level: 'info' | 'warn' | 'error';
	message: string;
	data?: unknown;
}

/**
 * Sent when document content changes in webview.
 * Used by virtual mode for auto-persistence.
 */
export interface DocumentChangedMessage {
	type: 'documentChanged';
	content: string;
	annotations: AnnotationContent[];
}

/**
 * Request to save document to a new file (Save As...).
 */
export interface SaveAsMessage {
	type: 'saveAs';
	requestId: string;
	content: string;
	annotations: AnnotationContent[];
}

/**
 * Request to reload document from disk after external change.
 * Only used in file mode.
 */
export interface ReloadFromDiskMessage {
	type: 'reloadFromDisk';
	requestId: string;
}

export type WebviewToExtensionMessage =
	| CreateSessionMessage
	| SendPromptMessage
	| AbortPromptMessage
	| GetThemeMessage
	| SaveDocumentMessage
	| LoadDocumentMessage
	| LogMessage
	| DocumentChangedMessage
	| SaveAsMessage
	| ReloadFromDiskMessage;

// ============================================
// Messages FROM extension host TO webview
// ============================================

export interface SessionCreatedMessage {
	type: 'sessionCreated';
	requestId: string;
	sessionId?: string;
	error?: string;
}

export interface PromptResponseMessage {
	type: 'promptResponse';
	requestId: string;
	response?: string;
	error?: string;
}

// Extension → Webview: Progress update during streaming
export interface PromptProgressMessage {
	type: 'promptProgress';
	requestId: string;
	wordCount: number;
}

export interface ThemeChangedMessage {
	type: 'themeChanged';
	requestId?: string;
	kind: 'light' | 'dark';
}

/** @deprecated Use initialContent instead */
export interface DocumentLoadedMessage {
	type: 'documentLoaded';
	requestId: string;
	content?: string;
	annotations?: AnnotationContent[];
	error?: string;
}

/** @deprecated Use saveAsResult instead */
export interface DocumentSavedMessage {
	type: 'documentSaved';
	requestId: string;
	success: boolean;
	error?: string;
}

/**
 * Initial content sent when webview opens.
 * Includes mode information and optional file name.
 */
export interface InitialContentMessage {
	type: 'initialContent';
	content: string;
	annotations: AnnotationContent[];
	mode: DocumentMode;
	fileName?: string;
}

/**
 * Notification that file changed externally (file mode only).
 * Webview should prompt user to reload or keep current content.
 */
export interface ExternalChangeMessage {
	type: 'externalChange';
}

/**
 * Result of Save As operation.
 */
export interface SaveAsResultMessage {
	type: 'saveAsResult';
	requestId: string;
	success: boolean;
	filePath?: string;
	error?: string;
}

/**
 * Content reloaded from disk (after user confirms reload).
 */
export interface ContentReloadedMessage {
	type: 'contentReloaded';
	requestId: string;
	content: string;
	annotations: AnnotationContent[];
	error?: string;
}

export type ExtensionToWebviewMessage =
	| SessionCreatedMessage
	| PromptResponseMessage
	| PromptProgressMessage
	| ThemeChangedMessage
	| DocumentLoadedMessage
	| DocumentSavedMessage
	| InitialContentMessage
	| ExternalChangeMessage
	| SaveAsResultMessage
	| ContentReloadedMessage;
