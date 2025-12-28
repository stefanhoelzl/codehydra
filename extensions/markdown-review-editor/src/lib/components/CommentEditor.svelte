<script lang="ts">
	import type { Message } from '$lib/utils/annotation-types';

	interface Props {
		/** Unique annotation ID this editor is associated with */
		annotationId: string;
		/** All messages in the conversation (unified format) */
		messages: Message[];
		/** Vertical position in the sidebar (pixels from top) */
		top: number;
		/** Callback to close/remove the annotation. If restoreSelection is true, select the unwrapped text. */
		onClose: (restoreSelection?: boolean) => void;
		/** Callback to set the comment content */
		onSetContent: (content: string) => void;
		/** Callback to focus the annotation in the document */
		onFocusAnnotation: () => void;
		/** Callback to focus the next comment editor */
		onFocusNextEditor: () => void;
		/** Callback to focus the previous comment editor */
		onFocusPreviousEditor: () => void;
		/** Callback when editor height changes (for overlap resolution) */
		onHeightChange?: (height: number) => void;
		/** Whether this editor/annotation is currently active/focused */
		isActive?: boolean;
		/** Callback when active state changes (focus/blur) */
		onActiveChange?: (isActive: boolean) => void;
	}

	let {
		annotationId,
		messages,
		top,
		onClose,
		onSetContent,
		onFocusAnnotation,
		onFocusNextEditor,
		onFocusPreviousEditor,
		onHeightChange,
		isActive = false,
		onActiveChange
	}: Props = $props();

	// Derive discussion messages (all except the last User message which is editable)
	const discussionMessages = $derived.by(() => {
		if (messages.length === 0) return [];
		const lastMsg = messages[messages.length - 1];
		// If last message is from User, exclude it (it's the editable content)
		if (lastMsg.author === 'User') {
			return messages.slice(0, -1);
		}
		// Otherwise all messages are discussion (no pending user input)
		return messages;
	});

	// Derive the editable content (last User message or empty)
	const editableContent = $derived.by(() => {
		if (messages.length === 0) return '';
		const lastMsg = messages[messages.length - 1];
		return lastMsg.author === 'User' ? lastMsg.content : '';
	});

	// Check if this is a reply (has prior discussion messages)
	const isReply = $derived(discussionMessages.length > 0);

	let textareaElement: HTMLTextAreaElement | null = $state(null);
	let editorElement: HTMLDivElement | null = $state(null);
	let discussionScrollArea: HTMLDivElement | null = $state(null);
	let internalContent = $state('');
	let isTextareaTruncated = $state(false);
	let isClickingWithinEditor = $state(false);
	let copyToast: { text: string; x: number; y: number } | null = $state(null);

	// Canvas for measuring text width (reused for performance)
	let measureCanvas: HTMLCanvasElement | null = null;

	/**
	 * Measure the width of the longest line in the given text
	 */
	function measureTextWidth(text: string, font: string): number {
		if (!measureCanvas) {
			measureCanvas = document.createElement('canvas');
		}
		const ctx = measureCanvas.getContext('2d');
		if (!ctx) return 0;

		ctx.font = font;

		// Measure each line and return the maximum width
		const lines = text.split('\n');
		let maxWidth = 0;
		for (const line of lines) {
			const metrics = ctx.measureText(line || ' ');
			maxWidth = Math.max(maxWidth, metrics.width);
		}
		return maxWidth;
	}

	// Sync internal content when editableContent changes (e.g., initial load)
	$effect(() => {
		internalContent = editableContent;
	});

	// Auto-resize textarea width and height based on content
	// Width must be set first so height measurement is accurate
	$effect(() => {
		if (!textareaElement || !editorElement) return;

		// Capture reactive values synchronously for dependency tracking
		const _content = internalContent;
		const currentIsActive = isActive;
		const ta = textareaElement;
		const editor = editorElement;

		// Use requestAnimationFrame to ensure layout is complete before measuring
		requestAnimationFrame(() => {
			if (!ta || !editor) return;

			const computedStyle = getComputedStyle(ta);
			const font = `${computedStyle.fontStyle} ${computedStyle.fontWeight} ${computedStyle.fontSize} ${computedStyle.fontFamily}`;

			// Step 1: Calculate and set width first
			const sidebar = editor.parentElement;
			const maxAvailableWidth = sidebar ? sidebar.clientWidth - 16 : 400; // 16px = 1em margin
			const textWidth = measureTextWidth(_content || ' ', font);
			const minWidth = 120;
			const paddingExtra = 16; // Extra space for cursor and breathing room
			const calculatedWidth = Math.min(
				Math.max(minWidth, textWidth + paddingExtra),
				maxAvailableWidth - 32 // Account for editor padding
			);
			ta.style.width = `${calculatedWidth}px`;

			// Step 2: Now measure and set height (after width is correct)
			if (currentIsActive) {
				// Full auto-resize when active
				ta.style.height = 'auto';
				ta.style.height = `${ta.scrollHeight}px`;
				ta.style.maxHeight = 'none';
			} else {
				// When minimized: measure full height, then let CSS constrain it
				ta.style.maxHeight = 'none';
				ta.style.height = 'auto';
				const fullHeight = ta.scrollHeight;

				// Calculate 3-line max height (line-height * 3 + padding)
				const lineHeight = parseFloat(computedStyle.lineHeight) || 16;
				const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
				const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
				const threeLineHeight = lineHeight * 3 + paddingTop + paddingBottom;

				// Check if content exceeds 3 lines
				isTextareaTruncated = fullHeight > threeLineHeight;

				// Set height to show up to 3 lines
				ta.style.height = `${Math.min(fullHeight, threeLineHeight)}px`;
				ta.style.maxHeight = `${threeLineHeight}px`;
			}
		});
	});

	// Track editor height changes and report to parent
	$effect(() => {
		if (!editorElement || !onHeightChange) return;

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) {
				const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
				onHeightChange(height);
			}
		});
		observer.observe(editorElement);

		return () => observer.disconnect();
	});

	function handleKeyDown(event: KeyboardEvent) {
		const isEmpty = internalContent.trim() === '';

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();

			if (isEmpty && !isReply) {
				// Empty content AND no prior discussion: remove annotation and restore selection
				onClose(true);
			} else {
				// Has content OR has prior discussion: save and focus the annotation in the document
				onSetContent(internalContent);
				onFocusAnnotation();
			}
			return;
		}

		if (event.key === 'Tab') {
			event.preventDefault();
			if (event.shiftKey) {
				onFocusPreviousEditor();
			} else {
				onFocusNextEditor();
			}
			return;
		}

		// Ctrl+Up: Scroll discussion up
		if (event.ctrlKey && event.key === 'ArrowUp') {
			event.preventDefault();
			if (discussionScrollArea) {
				discussionScrollArea.scrollBy({ top: -100, behavior: 'smooth' });
			}
			return;
		}

		// Ctrl+Down: Scroll discussion down
		if (event.ctrlKey && event.key === 'ArrowDown') {
			event.preventDefault();
			if (discussionScrollArea) {
				discussionScrollArea.scrollBy({ top: 100, behavior: 'smooth' });
			}
			return;
		}
	}

	function handleFocus() {
		// Notify parent that this editor is now active
		onActiveChange?.(true);
	}

	function handleBlur(event: FocusEvent) {
		// Save content when focus leaves the editor
		onSetContent(internalContent);

		// Check if focus is moving to another element within this editor
		const relatedTarget = event.relatedTarget as HTMLElement | null;
		if (relatedTarget && editorElement?.contains(relatedTarget)) {
			// Focus is still within this editor, don't deactivate
			return;
		}

		// Check if a click happened within this editor (e.g., selecting text)
		if (isClickingWithinEditor) {
			// Reset the flag and don't deactivate
			isClickingWithinEditor = false;
			return;
		}

		// Notify parent that this editor is no longer active
		onActiveChange?.(false);
	}

	function handleInput(event: Event) {
		const target = event.target as HTMLTextAreaElement;
		internalContent = target.value;

		// Immediate width resize first (so height measurement is accurate)
		const computedStyle = getComputedStyle(target);
		const font = `${computedStyle.fontStyle} ${computedStyle.fontWeight} ${computedStyle.fontSize} ${computedStyle.fontFamily}`;
		const textWidth = measureTextWidth(target.value || ' ', font);
		const minWidth = 120;
		const paddingExtra = 16;
		const sidebar = editorElement?.parentElement;
		const maxAvailableWidth = sidebar ? sidebar.clientWidth - 16 : 400;
		const calculatedWidth = Math.min(
			Math.max(minWidth, textWidth + paddingExtra),
			maxAvailableWidth - 32
		);
		target.style.width = `${calculatedWidth}px`;

		// Then height resize (after width is set)
		target.style.height = 'auto';
		target.style.height = `${target.scrollHeight}px`;
	}

	function handleContainerMouseDown(event: MouseEvent) {
		// Track that a click started within this editor (for blur handling)
		const target = event.target as HTMLElement;
		if (!target.closest('.comment-close')) {
			isClickingWithinEditor = true;
		}
	}

	function handleContainerClick(event: MouseEvent) {
		// Don't activate if clicking the close button
		const target = event.target as HTMLElement;
		if (target.closest('.comment-close')) {
			return;
		}

		activate();
	}

	async function handleDiscussionMouseUp(_event: MouseEvent) {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;

		const selectedText = selection.toString().trim();
		if (!selectedText) return;

		// Check if selection is within a message-content element
		const range = selection.getRangeAt(0);
		const container = range.commonAncestorContainer;
		const messageContent =
			container instanceof Element
				? container.closest('.message-content')
				: container.parentElement?.closest('.message-content');

		if (!messageContent) return;

		// Copy to clipboard
		try {
			await navigator.clipboard.writeText(selectedText);

			// Show toast near the selection
			const rect = range.getBoundingClientRect();
			const editorRect = editorElement?.getBoundingClientRect();
			if (editorRect) {
				copyToast = {
					text: 'Copied to clipboard',
					x: rect.left + rect.width / 2 - editorRect.left,
					y: rect.top - editorRect.top - 8
				};

				// Hide toast after 1.5 seconds
				setTimeout(() => {
					copyToast = null;
				}, 1500);
			}
		} catch (err) {
			console.error('Failed to copy text:', err);
		}
	}

	// Exported method to focus the textarea
	export function focus(): void {
		textareaElement?.focus({ preventScroll: true });
	}

	// Exported method to activate this editor (scroll + focus + highlight)
	export function activate(force: boolean = false): void {
		// Skip if already active - prevents unnecessary scrolling (unless forced)
		if (isActive && !force) return;

		// Step 1 & 2: Trigger active state - this scrolls to annotation AND expands
		onActiveChange?.(true);
		textareaElement?.focus({ preventScroll: true });

		// Wait for annotation scroll + bounce animation, then handle editor scrolling
		setTimeout(() => {
			if (!editorElement) return;
			setTimeout(() => {
				// Step 4: Scroll discussion to show beginning of last message
				if (discussionScrollArea && discussionMessages.length > 0) {
					const lastMessage = discussionScrollArea.querySelector('.discussion-message:last-child');
					lastMessage?.scrollIntoView({
						block: 'nearest',
						behavior: 'instant',
						container: 'nearest'
					});
				}
			}, 300);

			// Step 3: Scroll editor into main viewport
			editorElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}, 300); // Wait for annotation scroll + expansion
	}

	// Exported method to deactivate this editor (remove highlight)
	export function deactivate(): void {
		onActiveChange?.(false);
	}

	// Exported method to read current editor content without triggering state updates
	export function getCurrentContent(): string {
		return internalContent;
	}

	// Compute CSS classes
	const editorClass = $derived('comment-editor' + (isActive ? ' active' : ''));
</script>

<div
	class={editorClass}
	style="top: {top}px"
	data-annotation-id={annotationId}
	bind:this={editorElement}
	onmousedown={handleContainerMouseDown}
	onclick={handleContainerClick}
>
	<!-- Scrollable discussion area (only x-by messages scroll) -->
	{#if discussionMessages.length > 0}
		<div class="discussion-scroll-area" bind:this={discussionScrollArea}>
			<!-- Copy toast notification -->
			{#if copyToast}
				<div class="copy-toast" style="left: {copyToast.x}px; top: {copyToast.y}px">
					{copyToast.text}
				</div>
			{/if}

			<!-- Read-only discussion messages -->
			<div class="discussion-thread" onmouseup={handleDiscussionMouseUp}>
				{#if !isActive && discussionMessages.length > 2}
					<!-- Collapsed: show first + count + last message -->
					<div class="discussion-message minimized">
						<div class="message-content">{@html discussionMessages[0].content}</div>
					</div>
					<div class="collapsed-indicator">
						{discussionMessages.length - 2} more discussion contribution{discussionMessages.length >
						3
							? 's'
							: ''}...
					</div>
					<div
						class="discussion-message minimized last-message is-reply"
						class:is-ai={discussionMessages[discussionMessages.length - 1].author === 'AI'}
					>
						<svg class="reply-icon" viewBox="0 0 24 24"
							><path
								fill="currentColor"
								d="M10,9V5L3,12L10,19V14.9C15,14.9 18.5,16.5 21,20C20,15 17,10 10,9Z"
							/></svg
						>
						<div class="message-content">
							{@html discussionMessages[discussionMessages.length - 1].content}
						</div>
					</div>
				{:else}
					<!-- Expanded or single message: show all messages -->
					{#each discussionMessages as message, index (index)}
						<div
							class="discussion-message"
							class:is-reply={index > 0}
							class:minimized={!isActive}
							class:last-message={index === discussionMessages.length - 1}
							class:is-ai={message.author === 'AI'}
						>
							{#if index > 0}<svg class="reply-icon" viewBox="0 0 24 24"
									><path
										fill="currentColor"
										d="M10,9V5L3,12L10,19V14.9C15,14.9 18.5,16.5 21,20C20,15 17,10 10,9Z"
									/></svg
								>{/if}
							<div class="message-content">{@html message.content}</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}

	<!-- Current reply input (fixed at bottom, outside scroll area) -->
	<div class="reply-input" class:is-reply={isReply}>
		{#if isReply}<svg class="reply-icon" viewBox="0 0 24 24"
				><path
					fill="currentColor"
					d="M10,9V5L3,12L10,19V14.9C15,14.9 18.5,16.5 21,20C20,15 17,10 10,9Z"
				/></svg
			>{/if}
		<div
			class="textarea-wrapper"
			class:minimized={!isActive}
			class:truncated={!isActive && isTextareaTruncated}
		>
			<textarea
				bind:this={textareaElement}
				value={internalContent}
				oninput={handleInput}
				onkeydown={handleKeyDown}
				onfocus={handleFocus}
				onblur={handleBlur}
				placeholder={isReply ? 'Add a reply...' : 'Add a comment...'}
				rows="1"
			></textarea>
		</div>
	</div>

	<button
		class="comment-close"
		onclick={() => onClose()}
		type="button"
		aria-label="Remove annotation"
	>
		&times;
	</button>
</div>

<style>
	/* Subtle bounce easing - slight overshoot then settles */
	:root {
		--bounce-easing: cubic-bezier(0.25, 1.1, 0.5, 1);
		/* Keep in sync with BOUNCE_DURATION_MS constant in script */
		--bounce-duration: 0.3s;
	}

	.comment-editor {
		position: absolute;
		right: 0;
		width: fit-content;
		max-width: calc(100% - 1em);
		min-width: 150px;
		background-color: var(--color-annotation-bg);
		border: none;
		border-radius: var(--border-radius-lg);
		border-top-right-radius: 0;
		filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
		transition: background-color 0.2s ease;
	}

	/* Sprechblasen-Zeiger: Dreieck oben rechts */
	.comment-editor::after {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		width: 0;
		height: 0;
		border-style: solid;
		border-width: 14px 14px 0 0;
		border-color: var(--color-annotation-bg) transparent transparent transparent;
		transform: translateX(100%);
		transition: border-color 0.2s ease;
	}

	/* Active/focused state */
	.comment-editor.active {
		background-color: var(--color-annotation-bg-active);
		max-height: 90%;
		display: flex;
		flex-direction: column;
	}

	/* Scrollable discussion area (only x-by messages scroll) */
	.discussion-scroll-area {
		flex: 1;
		min-height: 0; /* Required for flex child to shrink below content size */
		position: relative; /* For copy toast positioning */
	}

	.comment-editor.active .discussion-scroll-area {
		overflow-y: auto;
	}

	.comment-editor.active::after {
		border-color: var(--color-annotation-bg-active) transparent transparent transparent;
	}

	/* Discussion thread container */
	.discussion-thread {
		padding: var(--spacing-sm) var(--spacing-md);
		padding-bottom: 0;
		min-width: 120px;
	}

	/* Collapsed indicator for hidden messages */
	.collapsed-indicator {
		font-size: var(--font-size-xs);
		color: var(--color-text-muted);
		font-style: italic;
		line-height: 1.2;
		margin-bottom: var(--spacing-sm);
		animation: fadeIn 0.2s ease-out;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	/* Remove margin from message before collapsed indicator */
	.discussion-message:has(+ .collapsed-indicator) {
		margin-bottom: 0;
	}

	/* Individual discussion message */
	.discussion-message {
		margin-bottom: var(--spacing-sm);
		font-size: var(--font-size-sm);
		line-height: var(--line-height-normal);
		color: var(--color-text-primary);
		transition: margin-bottom var(--bounce-duration) var(--bounce-easing);
	}

	/* Reply message has icon + indented content */
	.discussion-message.is-reply {
		position: relative;
		padding-left: 2em;
	}

	/* Reply icon styling */
	.reply-icon {
		position: absolute;
		left: 0;
		top: 0.1em;
		width: 1.2em;
		height: 1.2em;
		transform: rotate(180deg);
		opacity: 0.6;
	}

	/* Message content */
	.message-content {
		color: var(--color-text-primary);
		word-break: break-word;
	}

	/* AI messages - slightly blue tinted */
	.discussion-message.is-ai {
		color: #87ceeb;
	}

	.discussion-message.is-ai .message-content {
		color: #87ceeb;
	}

	/* Markdown elements in message content */
	.message-content :global(code) {
		background-color: var(--color-bg-tertiary);
		padding: 0.1em 0.3em;
		border-radius: var(--border-radius-sm);
		font-family: var(--font-family-mono);
		font-size: 0.9em;
	}

	.message-content :global(pre) {
		background-color: var(--color-bg-tertiary);
		padding: var(--spacing-sm);
		border-radius: var(--border-radius-sm);
		font-family: var(--font-family-mono);
		font-size: 0.9em;
		margin: 0.5em 0;
		overflow-x: auto;
		white-space: pre;
		line-height: 1.4;
	}

	.message-content :global(pre code) {
		background-color: transparent;
		padding: 0;
		border-radius: 0;
	}

	.message-content :global(strong) {
		font-weight: 600;
	}

	.message-content :global(em) {
		font-style: italic;
	}

	.message-content :global(a) {
		color: var(--color-link);
		text-decoration: underline;
	}

	.message-content :global(p) {
		margin: 0 0 0.5em 0;
	}

	.message-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.message-content :global(ul),
	.message-content :global(ol) {
		margin: 0.5em 0;
		padding-left: 1.5em;
	}

	.message-content :global(li) {
		margin: 0.25em 0;
	}

	.message-content :global(blockquote) {
		margin: 0.5em 0;
		padding-left: 0.75em;
		border-left: 3px solid var(--color-border);
		color: var(--color-text-secondary);
	}

	.message-content :global(table) {
		display: block;
		overflow-x: auto;
		border-collapse: collapse;
		margin: 0.5em 0;
	}

	.message-content :global(th),
	.message-content :global(td) {
		border: 1px solid var(--color-border);
		padding: 0.25em 0.5em;
		white-space: nowrap;
	}

	.message-content :global(th) {
		background-color: var(--color-bg-tertiary);
	}

	/* Minimized state - messages show 1 line with ellipsis */
	.discussion-message.minimized .message-content {
		display: -webkit-box;
		-webkit-line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* Minimized state - last message shows 2 lines with ellipsis */
	.discussion-message.minimized.last-message .message-content {
		-webkit-line-clamp: 2;
	}

	/* Current reply input container (fixed at bottom, outside scroll area) */
	.reply-input {
		position: relative;
		padding-right: var(--spacing-xl); /* Space for close button */
		padding-left: var(--spacing-md); /* Match discussion-thread padding */
		flex-shrink: 0; /* Prevent textarea from shrinking */
	}

	/* Reply input indented when replying - matches discussion message */
	.reply-input.is-reply {
		padding-left: calc(var(--spacing-md) + 2em);
		border-top: 1px solid var(--color-text-muted);
	}

	/* Reply icon in input area */
	.reply-input .reply-icon {
		left: var(--spacing-md);
		top: var(--spacing-sm);
	}

	/* Textarea wrapper */
	.textarea-wrapper {
		transition:
			-webkit-mask-image 0.2s ease-out,
			mask-image 0.2s ease-out;
	}

	/* Minimized textarea - 3 lines max */
	.textarea-wrapper.minimized textarea {
		max-height: calc(var(--line-height-normal) * 1em * 3 + var(--spacing-sm) * 2);
		overflow: hidden;
	}

	/* Text fade effect for truncated content */
	.textarea-wrapper.minimized.truncated textarea {
		-webkit-mask-image: linear-gradient(
			to bottom,
			black 0%,
			black calc(100% - 2.5em),
			transparent calc(100% - 0.75em)
		);
		mask-image: linear-gradient(
			to bottom,
			black 0%,
			black calc(100% - 2.5em),
			transparent calc(100% - 0.75em)
		);
	}

	textarea {
		width: 100%;
		min-width: 120px;
		padding: var(--spacing-sm) 0;
		border: none;
		background: transparent;
		color: var(--color-text-primary);
		font-family: var(--font-family-sans);
		font-size: var(--font-size-sm);
		line-height: var(--line-height-normal);
		resize: none;
		overflow: hidden;
		outline: none;
		transition:
			height var(--bounce-duration) var(--bounce-easing),
			max-height var(--bounce-duration) var(--bounce-easing);
	}

	textarea::placeholder {
		color: var(--color-text-secondary);
		font-style: italic;
	}

	textarea::selection,
	.message-content :global(::selection) {
		background-color: var(--color-editor-selection-bg);
	}

	.comment-close {
		position: absolute;
		top: var(--spacing-xs);
		right: var(--spacing-xs);
		width: 20px;
		height: 20px;
		border: none;
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		font-size: var(--font-size-lg);
		line-height: 1;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--border-radius-sm);
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.comment-editor:hover .comment-close {
		opacity: 1;
	}

	.comment-close:hover {
		background-color: var(--color-bg-hover);
		color: var(--color-text-primary);
	}

	/* Copy toast notification */
	.copy-toast {
		position: absolute;
		transform: translateX(-50%) translateY(-100%);
		background-color: var(--color-bg-tertiary);
		color: var(--color-text-primary);
		padding: 0.25em 0.5em;
		border-radius: var(--border-radius-sm);
		font-size: var(--font-size-xs);
		white-space: nowrap;
		z-index: 10;
		pointer-events: none;
		animation: toastFadeInOut 1.5s ease-out forwards;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
	}

	@keyframes toastFadeInOut {
		0% {
			opacity: 0;
			transform: translateX(-50%) translateY(-80%);
		}
		15% {
			opacity: 1;
			transform: translateX(-50%) translateY(-100%);
		}
		85% {
			opacity: 1;
			transform: translateX(-50%) translateY(-100%);
		}
		100% {
			opacity: 0;
			transform: translateX(-50%) translateY(-120%);
		}
	}
</style>
