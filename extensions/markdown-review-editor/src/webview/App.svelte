<script lang="ts">
	import HtmlAnnotator from '../lib/components/HtmlAnnotator.svelte';
	import { applyComments } from '../lib/utils/opencode';
	import type { AnnotationContent } from '../lib/utils/annotation-types';
	import { getVsCodeApi, abortPrompt } from '../lib/services/opencode-client';
	import type {
		ExtensionToWebviewMessage,
		InitialContentMessage,
		ContentReloadedMessage,
		DocumentMode
	} from '../extension/message-types';
	import { onMount } from 'svelte';

	let annotator: HtmlAnnotator;

	// Document mode and state (mode is stored for future use)
	let _mode: DocumentMode = $state('virtual');
	let fileName: string | undefined = $state(undefined);
	let showExternalChangeDialog = $state(false);
	let pendingReloadRequestId: string | undefined = $state(undefined);

	// Loading state using Svelte 5 runes
	let isApplying = $state(false);
	let applyError = $state<string | null>(null);
	let wordCount = $state<number | null>(null);
	let currentRequestId = $state<string | null>(null);

	onMount(() => {
		// Listen for messages from extension
		window.addEventListener('message', handleExtensionMessage);
		return () => {
			window.removeEventListener('message', handleExtensionMessage);
		};
	});

	function handleExtensionMessage(event: MessageEvent) {
		const message = event.data as ExtensionToWebviewMessage;

		switch (message.type) {
			case 'initialContent': {
				const msg = message as InitialContentMessage;
				_mode = msg.mode;
				fileName = msg.fileName;

				// Set document content
				annotator.setDocument(msg.content);

				// Set annotations
				for (const annotation of msg.annotations) {
					annotator.setAnnotation(annotation.id, annotation);
				}

				applyError = null;
				break;
			}

			case 'contentReloaded': {
				const msg = message as ContentReloadedMessage;
				if (msg.error) {
					applyError = msg.error;
				} else {
					annotator.setDocument(msg.content);
					for (const annotation of msg.annotations) {
						annotator.setAnnotation(annotation.id, annotation);
					}
					applyError = null;
				}
				showExternalChangeDialog = false;
				break;
			}

			case 'externalChange': {
				// File changed on disk, prompt user
				showExternalChangeDialog = true;
				pendingReloadRequestId = `reload-${Date.now()}`;
				break;
			}

			case 'saveAsResult': {
				if ('error' in message && message.error && message.error !== 'Save cancelled') {
					applyError = message.error;
				}
				break;
			}
		}
	}

	/**
	 * Notify extension that document content changed.
	 * Called after any content modification.
	 */
	function notifyContentChanged() {
		const documentHtml = annotator.getDocument();
		const annotations = getAllAnnotations();

		getVsCodeApi().postMessage({
			type: 'documentChanged',
			content: documentHtml,
			annotations
		});
	}

	/**
	 * Get all annotations from the annotator.
	 */
	function getAllAnnotations(): AnnotationContent[] {
		const annotationIds = annotator.getAllAnnotationIds();
		const annotations: AnnotationContent[] = [];

		for (const id of annotationIds) {
			const content = annotator.getAnnotation(id);
			if (content) {
				annotations.push(content);
			}
		}

		return annotations;
	}

	function handleCancel() {
		if (currentRequestId) {
			abortPrompt(currentRequestId);
		}
	}

	async function handleApplyComments() {
		applyError = null;
		isApplying = true;
		wordCount = null;

		// Generate requestId immediately so Cancel works from the start
		// This requestId is shared across createSession and sendPrompt for unified abort
		currentRequestId = `apply-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		try {
			// 1. Get document and annotations from annotator
			const originalDocument = annotator.getDocument();
			const annotations = getAllAnnotations();

			// 2. Send to OpenCode with progress callback
			const result = await applyComments(annotations, originalDocument, {
				requestId: currentRequestId,
				onProgress: ({ wordCount: wc }) => {
					wordCount = wc;
				}
			});

			if (result.success) {
				// 3. Apply answers to annotations
				if (result.answers) {
					for (const answer of result.answers) {
						annotator.setAnnotation(answer.id, answer);
					}
				}

				// 4. Update document with diff highlighting (preserves annotation states)
				if (result.document) {
					annotator.setDocument(result.document, originalDocument);
				}

				// 5. Handle non-answered but prompted annotations (CLEAR INSTRUCTIONs)
				// These should have their annotation removed/unwrapped
				if (result.promptedIds && result.answers) {
					const answeredIds = new Set(result.answers.map((a) => a.id));
					for (const id of result.promptedIds) {
						if (!answeredIds.has(id)) {
							// This was a CLEAR INSTRUCTION - delete the annotation
							annotator.delAnnotation(id);
						}
					}
				}

				// 6. Notify extension of changes (triggers persistence)
				notifyContentChanged();
			} else {
				applyError = result.error || 'Failed to process comments';
			}
		} catch (error) {
			applyError = error instanceof Error ? error.message : 'Unexpected error';
		} finally {
			isApplying = false;
			currentRequestId = null;
		}
	}

	function handleSaveAs() {
		const documentHtml = annotator.getDocument();
		const annotations = getAllAnnotations();

		getVsCodeApi().postMessage({
			type: 'saveAs',
			requestId: `saveas-${Date.now()}`,
			content: documentHtml,
			annotations
		});
	}

	function handleReloadFromDisk() {
		if (pendingReloadRequestId) {
			getVsCodeApi().postMessage({
				type: 'reloadFromDisk',
				requestId: pendingReloadRequestId
			});
		}
		showExternalChangeDialog = false;
	}

	function handleKeepMine() {
		showExternalChangeDialog = false;
		// Mark as dirty by notifying of change
		notifyContentChanged();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.ctrlKey && e.key === 'Enter' && !isApplying) {
			e.preventDefault();
			handleApplyComments();
		}
	}}
/>

<div class="page">
	<div class="toolbar">
		{#if isApplying}
			<button disabled>
				<span class="spinner"></span>
				Applying...{#if wordCount !== null}
					({wordCount} words received){/if}
			</button>
			<button class="cancel-button" onclick={handleCancel}>Cancel</button>
		{:else}
			<button onclick={handleApplyComments} disabled={isApplying}>
				Apply Comments (Ctrl-Enter)...
			</button>
		{/if}
		{#if applyError}
			<span class="error-message">{applyError}</span>
		{/if}
		<div class="toolbar-spacer"></div>
		{#if fileName}
			<span class="file-name">{fileName}</span>
		{/if}
		<button onclick={handleSaveAs}>Save As...</button>
	</div>

	<HtmlAnnotator bind:this={annotator} onContentChange={notifyContentChanged} />

	{#if showExternalChangeDialog}
		<div class="dialog-overlay">
			<div class="dialog">
				<p>File changed on disk. What would you like to do?</p>
				<div class="dialog-buttons">
					<button onclick={handleReloadFromDisk}>Reload from Disk</button>
					<button onclick={handleKeepMine}>Keep My Changes</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		height: 100vh;
		width: 100vw;
		display: flex;
		flex-direction: column;
	}

	.toolbar {
		padding: var(--spacing-sm) var(--spacing-md);
		background-color: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: var(--spacing-md);
	}

	.toolbar-spacer {
		flex: 1;
	}

	.file-name {
		color: var(--color-text-secondary);
		font-size: var(--font-size-sm);
		font-family: var(--font-family-mono);
	}

	.toolbar button {
		padding: var(--spacing-xs) var(--spacing-md);
		background-color: var(--color-accent-primary);
		color: var(--color-bg-primary);
		border: none;
		border-radius: var(--border-radius-sm);
		font-family: var(--font-family-sans);
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: var(--spacing-sm);
	}

	.toolbar button:hover:not(:disabled) {
		opacity: 0.9;
	}

	.toolbar button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.toolbar button.cancel-button {
		background-color: var(--color-error, #d32f2f);
	}

	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid transparent;
		border-top-color: currentColor;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.error-message {
		color: var(--color-error);
		font-size: var(--font-size-sm);
	}

	/* External change dialog */
	.dialog-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog {
		background-color: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: var(--border-radius-md);
		padding: var(--spacing-lg);
		max-width: 400px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	.dialog p {
		margin: 0 0 var(--spacing-md) 0;
		color: var(--color-text-primary);
	}

	.dialog-buttons {
		display: flex;
		gap: var(--spacing-sm);
		justify-content: flex-end;
	}

	.dialog-buttons button {
		padding: var(--spacing-xs) var(--spacing-md);
		border-radius: var(--border-radius-sm);
		font-family: var(--font-family-sans);
		cursor: pointer;
	}

	.dialog-buttons button:first-child {
		background-color: var(--color-accent-primary);
		color: var(--color-bg-primary);
		border: none;
	}

	.dialog-buttons button:last-child {
		background-color: transparent;
		color: var(--color-text-primary);
		border: 1px solid var(--color-border);
	}
</style>
