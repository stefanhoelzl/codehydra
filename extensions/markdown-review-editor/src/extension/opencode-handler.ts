/**
 * OpenCode SDK handler for VS Code extension host.
 * Handles OpenCode API calls directly without needing a proxy server.
 *
 * The OpenCode port must be initialized before use by calling initializeOpencodePort().
 * This is typically done during extension activation by fetching the port from
 * the CodeHydra sidekick extension.
 */

import { createOpencodeClient } from '@opencode-ai/sdk';
import * as vscode from 'vscode';
import { logger } from './logger';

let client: ReturnType<typeof createOpencodeClient> | null = null;

/** The OpenCode server port, set during initialization */
let opencodePort: number | null = null;

/** Default timeout for session creation in milliseconds */
const SESSION_CREATION_TIMEOUT_MS = 10000;

/**
 * Initialize the OpenCode port. Must be called before any OpenCode operations.
 * @param port - The OpenCode server port number
 */
export function initializeOpencodePort(port: number): void {
	opencodePort = port;
	// Reset client so it will be recreated with new port
	client = null;
	logger.info(`OpenCode port initialized: ${port}`);
}

/**
 * Check if OpenCode is initialized and ready to use.
 */
export function isOpencodeInitialized(): boolean {
	return opencodePort !== null;
}

/**
 * Create a promise that rejects when the abort signal fires.
 */
function createAbortPromise(signal?: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal?.aborted) {
			reject(new Error('ABORTED'));
			return;
		}
		signal?.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
	});
}

/**
 * Get the project directory from workspace folders.
 */
function getProjectDir(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		return workspaceFolders[0].uri.fsPath;
	}
	return '';
}

/**
 * Get or create the OpenCode client singleton.
 * @throws Error if OpenCode port has not been initialized
 */
function getOpencodeClient(): ReturnType<typeof createOpencodeClient> {
	if (opencodePort === null) {
		throw new Error(
			'OpenCode not initialized. The CodeHydra sidekick extension may not be available.'
		);
	}

	if (!client) {
		const projectDir = getProjectDir();
		const baseUrl = `http://127.0.0.1:${opencodePort}`;
		logger.debug(`Creating OpenCode client: baseUrl=${baseUrl}, directory=${projectDir}`);
		client = createOpencodeClient({
			baseUrl,
			directory: projectDir
		});
	}
	return client;
}

/**
 * Create a new OpenCode session.
 * @param title - Session title
 * @param options - Optional abort signal and timeout
 * @param options.signal - AbortSignal for cancellation
 * @param options.timeout - Timeout in milliseconds (default: 10000)
 */
export async function createSession(
	title: string,
	options?: { signal?: AbortSignal; timeout?: number }
): Promise<{ sessionId?: string; error?: string }> {
	// Check if already aborted
	if (options?.signal?.aborted) {
		return { error: 'User cancelled operation' };
	}

	try {
		logger.info(`Creating OpenCode session: title="${title}"`);
		const opencodeClient = getOpencodeClient();

		// Create timeout promise
		const timeout = options?.timeout ?? SESSION_CREATION_TIMEOUT_MS;
		let timeoutId: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), timeout);
		});

		// Create abort promise (only if signal provided)
		const abortPromise = options?.signal ? createAbortPromise(options.signal) : null;

		// Build the race array
		const racePromises: Promise<unknown>[] = [
			opencodeClient.session.create({
				body: { title },
				query: { directory: getProjectDir() }
			}),
			timeoutPromise
		];
		if (abortPromise) {
			racePromises.push(abortPromise);
		}

		// Race the actual call against timeout and abort
		const result = (await Promise.race(racePromises)) as Awaited<
			ReturnType<typeof opencodeClient.session.create>
		>;

		// Clear timeout on success
		if (timeoutId) clearTimeout(timeoutId);

		if (result.data?.id) {
			logger.info(`Session created successfully: sessionId=${result.data.id}`);
			return { sessionId: result.data.id };
		}
		logger.warn(`Session creation returned no ID: ${JSON.stringify(result)}`);
		return { error: 'Failed to create session: no ID returned' };
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === 'ABORTED') {
				logger.info('Session creation cancelled by user');
				return { error: 'User cancelled operation' };
			}
			if (error.message === 'TIMEOUT') {
				logger.error('Session creation timed out');
				return { error: 'OpenCode server not responding (connection timeout)' };
			}
		}
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error(`Failed to create session: ${message}`);
		return { error: `Failed to create session: ${message}` };
	}
}

/**
 * Send a prompt to an existing session with optional streaming support.
 */
export async function sendPrompt(
	sessionId: string,
	prompt: string,
	options?: {
		onProgress?: (wordCount: number) => void;
		signal?: AbortSignal;
	}
): Promise<{ response?: string; error?: string }> {
	try {
		logger.info(
			`Sending prompt to OpenCode: sessionId=${sessionId}, promptLength=${prompt.length}`
		);
		logger.debug(`========== PROMPT TO OPENCODE ==========\n${prompt}`);

		const opencodeClient = getOpencodeClient();

		// If streaming is requested, use event subscription
		if (options?.onProgress || options?.signal) {
			return await sendPromptWithStreaming(opencodeClient, sessionId, prompt, options);
		}

		// Non-streaming path (original behavior)
		const result = await opencodeClient.session.prompt({
			path: { id: sessionId },
			body: {
				model: {
					providerID: 'anthropic',
					modelID: 'claude-opus-4-5-20251101'
				},
				parts: [{ type: 'text', text: prompt }]
			},
			query: { directory: getProjectDir() }
		});

		if (!result.data?.parts) {
			logger.warn(`No response parts from OpenCode: ${JSON.stringify(result)}`);
			return { error: 'No response from OpenCode' };
		}

		// Extract text from response parts
		const texts = result.data.parts
			.filter((p) => p.type === 'text')
			.map((p) => ('text' in p ? p.text : ''))
			.filter(Boolean);

		const response = texts.join('\n').trim();

		logger.info(`Received response from OpenCode: responseLength=${response.length}`);
		logger.debug(`========== RESPONSE FROM OPENCODE ==========\n${response}`);

		return { response };
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		logger.error(`Failed to send prompt: ${message}`);
		return { error: `Failed to send prompt: ${message}` };
	}
}

/**
 * Send prompt with streaming support using event subscription.
 * Uses Promise.race to make the event stream loop interruptible by abort signal.
 */
async function sendPromptWithStreaming(
	opencodeClient: ReturnType<typeof createOpencodeClient>,
	sessionId: string,
	prompt: string,
	options: {
		onProgress?: (wordCount: number) => void;
		signal?: AbortSignal;
	}
): Promise<{ response?: string; error?: string }> {
	let accumulatedText = '';
	let finished = false;

	// Check if already aborted
	if (options.signal?.aborted) {
		return { error: 'User cancelled operation' };
	}

	// Create abort promise that we'll race against blocking operations
	const abortPromise = options.signal ? createAbortPromise(options.signal) : null;

	// Helper to try aborting the session on the server (fire and forget)
	const tryAbortSession = () => {
		opencodeClient.session.abort({ path: { id: sessionId } }).catch(() => {
			// Ignore abort errors - server might be down
		});
	};

	try {
		// Subscribe to events FIRST - race against abort
		const eventStreamPromise = opencodeClient.event.subscribe({
			query: { directory: getProjectDir() }
		});

		const eventStream = abortPromise
			? await Promise.race([eventStreamPromise, abortPromise])
			: await eventStreamPromise;

		// Start the prompt - don't await it yet!
		// The prompt runs in background while we process events
		const promptPromise = opencodeClient.session.prompt({
			path: { id: sessionId },
			body: {
				model: {
					providerID: 'anthropic',
					modelID: 'claude-opus-4-5-20251101'
				},
				parts: [{ type: 'text', text: prompt }]
			},
			query: { directory: getProjectDir() }
		});

		// Process events from the stream
		// We need to make the for-await loop interruptible
		if (eventStream.stream) {
			// Create an async iterator that we can race against abort
			const iterator = eventStream.stream[Symbol.asyncIterator]();

			while (!finished) {
				// Race each iteration against the abort signal
				const nextPromise = iterator.next();
				const iterationResult = abortPromise
					? await Promise.race([nextPromise, abortPromise])
					: await nextPromise;

				// Check if we got an abort (abortPromise rejects, so we won't reach here if aborted)
				// But double-check the signal anyway
				if (options.signal?.aborted) {
					tryAbortSession();
					return { error: 'User cancelled operation' };
				}

				// Check if stream ended
				if (iterationResult.done) {
					break;
				}

				const event = iterationResult.value;

				// Filter events for this session
				const properties = event.properties as {
					part?: { sessionID?: string; type?: string };
					info?: { sessionID?: string; finish?: string; role?: string };
					delta?: string;
				};
				const eventSessionId = properties?.part?.sessionID || properties?.info?.sessionID;

				if (eventSessionId && eventSessionId !== sessionId) {
					continue;
				}

				// Handle message.part.updated events (streaming delta)
				if (event.type === 'message.part.updated') {
					const partProps = properties?.part as { delta?: string; type?: string } | undefined;
					const delta = partProps?.delta || properties?.delta;
					if (delta) {
						accumulatedText += delta;
						const wordCount = accumulatedText.split(/\s+/).filter(Boolean).length;
						options.onProgress?.(wordCount);
					}
				}

				// Handle message.updated with finish property (completion)
				if (event.type === 'message.updated') {
					const infoProps = properties?.info as { finish?: string; role?: string } | undefined;
					// Check if this is the assistant message with a finish reason
					if (infoProps?.role === 'assistant' && infoProps?.finish) {
						finished = true;
						break;
					}
				}
			}
		}

		// Check if abort was triggered - if so, return error immediately
		// Do NOT use accumulated partial text as it would corrupt the document
		if (options.signal?.aborted) {
			tryAbortSession();
			return { error: 'User cancelled operation' };
		}

		// Now wait for the prompt to fully complete - race against abort
		const result = abortPromise
			? await Promise.race([
					promptPromise,
					abortPromise.catch(() => null) // Convert rejection to null on abort
				])
			: await promptPromise;

		// Check abort again after prompt completes
		if (options.signal?.aborted || result === null) {
			tryAbortSession();
			return { error: 'User cancelled operation' };
		}

		if (!result.data?.parts) {
			// If we have accumulated text from events, use that
			if (accumulatedText) {
				return { response: accumulatedText };
			}
			return { error: 'No response from OpenCode' };
		}

		// Extract text from response parts (prefer this over accumulated)
		const texts = result.data.parts
			.filter((p) => p.type === 'text')
			.map((p) => ('text' in p ? p.text : ''))
			.filter(Boolean);

		const response = texts.join('\n').trim() || accumulatedText;

		return { response };
	} catch (error) {
		// Check if this was an abort
		if (error instanceof Error && error.message === 'ABORTED') {
			tryAbortSession();
			return { error: 'User cancelled operation' };
		}
		if (options.signal?.aborted) {
			tryAbortSession();
			return { error: 'User cancelled operation' };
		}
		const message = error instanceof Error ? error.message : 'Unknown error';
		return { error: `Failed to send prompt: ${message}` };
	}
}

/**
 * Reset the client (useful when workspace changes).
 * Note: This does not reset the port - call initializeOpencodePort() to change the port.
 */
export function resetClient(): void {
	logger.debug('Resetting OpenCode client');
	client = null;
}

/**
 * Reset the OpenCode handler completely (clears both client and port).
 * Call this during extension deactivation.
 */
export function resetOpencodeHandler(): void {
	logger.debug('Resetting OpenCode handler');
	client = null;
	opencodePort = null;
}
