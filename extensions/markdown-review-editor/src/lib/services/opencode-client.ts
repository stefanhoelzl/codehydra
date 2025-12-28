/**
 * OpenCode client wrapper for VS Code webview.
 * Uses message passing to communicate with the extension host.
 */

import type {
	WebviewToExtensionMessage,
	ExtensionToWebviewMessage,
	SessionCreatedMessage,
	PromptResponseMessage,
	PromptProgressMessage
} from '../../extension/message-types';

// VS Code API instance (acquired once)
interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let vscodeApi: VsCodeApi | null = null;

/**
 * Get the VS Code API instance.
 */
export function getVsCodeApi(): VsCodeApi {
	if (!vscodeApi) {
		vscodeApi = acquireVsCodeApi();
	}
	return vscodeApi;
}

// Request ID counter for correlating responses
let requestIdCounter = 0;

// Pending requests waiting for responses
const pendingRequests = new Map<
	string,
	{
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}
>();

/**
 * Initialize message listener for responses from extension host.
 * Call this once when the webview loads.
 */
export function initializeMessageListener(): void {
	window.addEventListener('message', (event) => {
		const message = event.data as ExtensionToWebviewMessage;

		// Handle progress updates during streaming
		if (message.type === 'promptProgress') {
			const progressMsg = message as PromptProgressMessage;
			const listener = progressListeners.get(progressMsg.requestId);
			if (listener) {
				listener(progressMsg.wordCount);
			}
			return;
		}

		// Handle responses with requestId
		if ('requestId' in message && message.requestId) {
			const pending = pendingRequests.get(message.requestId);
			if (pending) {
				pendingRequests.delete(message.requestId);
				// Clean up progress listener
				progressListeners.delete(message.requestId);
				pending.resolve(message);
			}
		}

		// Theme changes without requestId are broadcast updates
		if (message.type === 'themeChanged' && !('requestId' in message && message.requestId)) {
			// Dispatch custom event for theme updates
			window.dispatchEvent(new CustomEvent('vscode-theme-change', { detail: message }));
		}
	});
}

// Progress listeners for streaming updates
const progressListeners = new Map<string, (wordCount: number) => void>();

/**
 * Send a message to the extension host and wait for response.
 */
function _sendRequest<T extends ExtensionToWebviewMessage>(
	message: Record<string, unknown>
): Promise<T> {
	const requestId = `req-${++requestIdCounter}`;
	const fullMessage = { ...message, requestId } as WebviewToExtensionMessage;

	return new Promise((resolve, reject) => {
		pendingRequests.set(requestId, {
			resolve: resolve as (value: unknown) => void,
			reject
		});

		getVsCodeApi().postMessage(fullMessage);

		// No timeout - user can cancel manually
	});
}

/**
 * Create a new OpenCode session.
 * @param title - Session title
 * @param requestId - Request ID for abort support (shared with sendPrompt)
 */
export async function createSession(
	title: string,
	requestId: string
): Promise<{ data?: { id: string }; error?: string }> {
	const response = await sendRequestWithId<SessionCreatedMessage>(
		{ type: 'createSession', title },
		requestId
	);

	if (response.error) {
		return { error: response.error };
	}

	return { data: { id: response.sessionId! } };
}

/**
 * Send a prompt to an existing session.
 * @param sessionId - The session ID to send the prompt to
 * @param prompt - The prompt text
 * @param options - Options including requestId for abort support and progress callback
 * @param options.requestId - Request ID (shared with createSession for unified abort)
 * @param options.onProgress - Callback for progress updates during streaming
 */
export async function sendPrompt(
	sessionId: string,
	prompt: string,
	options: {
		requestId: string;
		onProgress?: (wordCount: number) => void;
	}
): Promise<{
	data?: { parts: Array<{ type: string; text?: string }> };
	error?: string;
}> {
	const response = await sendRequestWithId<PromptResponseMessage>(
		{
			type: 'sendPrompt',
			sessionId,
			prompt
		},
		options.requestId,
		{ onProgress: options.onProgress }
	);

	if (response.error) {
		return { error: response.error };
	}

	// Wrap response in expected format
	return {
		data: {
			parts: [{ type: 'text', text: response.response }]
		}
	};
}

/**
 * Send a message to the extension host with a specific requestId and wait for response.
 */
function sendRequestWithId<T extends ExtensionToWebviewMessage>(
	message: Record<string, unknown>,
	requestId: string,
	callbacks?: { onProgress?: (wordCount: number) => void }
): Promise<T> {
	const fullMessage = { ...message, requestId } as WebviewToExtensionMessage;

	return new Promise((resolve, reject) => {
		pendingRequests.set(requestId, {
			resolve: resolve as (value: unknown) => void,
			reject
		});

		// Register progress listener if provided
		if (callbacks?.onProgress) {
			progressListeners.set(requestId, callbacks.onProgress);
		}

		getVsCodeApi().postMessage(fullMessage);

		// No timeout - user can cancel manually
	});
}

/**
 * Abort an ongoing prompt request.
 */
export function abortPrompt(requestId: string): void {
	getVsCodeApi().postMessage({
		type: 'abortPrompt',
		requestId
	} as WebviewToExtensionMessage);
}

/**
 * Log a message to the extension host.
 */
export function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
	getVsCodeApi().postMessage({
		type: 'log',
		level,
		message,
		data
	} as WebviewToExtensionMessage);
}
