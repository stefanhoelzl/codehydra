<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		snapSelection as doSnapSelection,
		wrapSelectionWithAnnotation,
		removeAnnotation,
		generateAnnotationId,
		wrapTextNodesWithHighlight,
		type SnappedSelection
	} from '$lib/utils/selection';
	import { registerAnnotationElements, type AnnotationCloseDetail } from './annotation-elements';
	import CommentEditor from './CommentEditor.svelte';
	import type { Message, AnnotationContent } from '$lib/utils/annotation-types';
	import { markdownToHtml } from '$lib/utils/html-to-markdown';
	import { diffHtml, stripModifiedTags } from '$lib/utils/html-diff';

	interface Props {
		/** Theme mode */
		theme?: 'light' | 'dark' | 'system';
		/** Additional CSS class */
		class?: string;
		/** Callback when content changes (e.g., annotation added/removed) */
		onContentChange?: (newContent: string) => void;
	}

	let { theme = 'system', class: className = '', onContentChange }: Props = $props();

	// Internal state
	let containerElement: HTMLElement | null = $state(null);

	// Annotation state tracking - using unified messages array
	interface AnnotationState {
		id: string;
		messages: Message[]; // All messages including current editable content (last User message)
		resolvedTop: number; // Actual position after overlap resolution
	}

	let annotations = new SvelteMap<string, AnnotationState>();
	let editorHeights = new SvelteMap<string, number>(); // Track actual CommentEditor heights
	let editorRefs: Record<string, CommentEditor | undefined> = {};
	let activeAnnotationId = $state<string | null>(null);

	// Constants for overlap resolution
	const COMMENT_PADDING = 8; // Gap between comments
	const DEFAULT_EDITOR_HEIGHT = 60; // Fallback before measurement

	/**
	 * Parse all messages from an x-comment element.
	 * Messages are stored as <msg author="...">content</msg> elements.
	 * The last User message represents the current editable content.
	 */
	function parseMessages(commentEl: Element | null): Message[] {
		if (!commentEl) return [];
		return Array.from(commentEl.querySelectorAll('msg')).map((msg) => ({
			author: msg.getAttribute('author') || '',
			content: msg.innerHTML || ''
		}));
	}

	/**
	 * Convert message content from markdown to HTML for display.
	 * Only converts discussion messages (AI responses), not the editable User message.
	 */
	function convertMessagesToHtml(messages: Message[]): Message[] {
		return messages.map((msg, index) => {
			// Don't convert the last User message (it's editable, keep as plain text)
			if (index === messages.length - 1 && msg.author === 'User') {
				return msg;
			}
			// Convert markdown to HTML for display
			return {
				author: msg.author,
				content: markdownToHtml(msg.content)
			};
		});
	}

	// Register custom elements on mount (only needs to run once)
	onMount(() => {
		registerAnnotationElements();
	});

	// Attach event listener when containerElement becomes available
	// (Using $effect because bind:this resolves after onMount)
	$effect(() => {
		if (!containerElement) return;

		const handleClose = (event: Event) => {
			handleAnnotationClose(event as CustomEvent<AnnotationCloseDetail>);
		};
		containerElement.addEventListener('annotation-close', handleClose);

		return () => {
			containerElement.removeEventListener('annotation-close', handleClose);
		};
	});

	// Apply theme to container
	$effect(() => {
		if (containerElement) {
			containerElement.setAttribute('data-theme', theme);
		}
	});

	// MutationObserver to detect new annotations in the DOM
	$effect(() => {
		if (!containerElement) return;

		const contentDiv = containerElement.querySelector('.html-annotator-content');
		if (!contentDiv) return;

		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				// Check for added annotation elements
				mutation.addedNodes.forEach((node) => {
					if (node instanceof HTMLElement && node.tagName === 'X-ANNOTATION') {
						const id = node.getAttribute('id');
						if (id && !annotations.has(id)) {
							// Read initial messages from x-comment if present
							const commentEl = node.querySelector('x-comment');
							const messages = parseMessages(commentEl);
							// If no messages and no editable content, add empty User message for editing
							if (messages.length === 0) {
								messages.push({ author: 'User', content: '' });
							}

							annotations.set(id, {
								id,
								messages,
								resolvedTop: 0
							});

							// Focus the editor after it's rendered
							tick().then(() => {
								const editor = editorRefs[id];
								editor?.focus();
							});
						}
					}
				});

				// Check for removed annotation elements
				mutation.removedNodes.forEach((node) => {
					if (node instanceof HTMLElement && node.tagName === 'X-ANNOTATION') {
						const id = node.getAttribute('id');
						if (id && annotations.has(id)) {
							annotations.delete(id);
							editorHeights.delete(id);
							delete editorRefs[id];
						}
					}
				});
			}
		});

		observer.observe(contentDiv, {
			childList: true,
			subtree: true
		});

		return () => observer.disconnect();
	});

	// Overlap resolution function - calculates resolved positions for all annotations
	function resolveOverlaps(): void {
		if (!containerElement) return;

		const contentDiv = containerElement.querySelector('.html-annotator-content');
		if (!contentDiv) return;

		// 1. Collect all annotations with their DOM elements and positions
		const positionData: { id: string; element: Element; idealTop: number; height: number }[] = [];

		for (const [id] of annotations) {
			const annotationEl = contentDiv.querySelector(`x-annotation[id="${id}"]`);
			if (annotationEl) {
				const annotatorRect = containerElement.getBoundingClientRect();
				const annotationRect = annotationEl.getBoundingClientRect();
				const idealTop = annotationRect.top - annotatorRect.top + containerElement.scrollTop;
				const height = editorHeights.get(id) || DEFAULT_EDITOR_HEIGHT;
				positionData.push({ id, element: annotationEl, idealTop, height });
			}
		}

		// 2. Sort by DOM order (text flow order) using compareDocumentPosition
		positionData.sort((a, b) => {
			const position = a.element.compareDocumentPosition(b.element);
			if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
			if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
			// Fallback to idealTop if same position (shouldn't happen)
			return a.idealTop - b.idealTop;
		});

		// 3. Resolve overlaps: each comment starts at max(idealTop, previousBottom + padding)
		let nextAvailableTop = 0;
		let _hasChanges = false;

		for (const data of positionData) {
			const resolvedTop = Math.max(data.idealTop, nextAvailableTop);
			const state = annotations.get(data.id);
			if (state && Math.abs(state.resolvedTop - resolvedTop) > 0.5) {
				// IMPORTANT: Create a NEW object for Svelte 5 reactivity
				annotations.set(data.id, { ...state, resolvedTop });
				_hasChanges = true;
			}
			nextAvailableTop = resolvedTop + data.height + COMMENT_PADDING;
		}

		// SvelteMap automatically triggers reactivity on set()
	}

	// Effect to trigger overlap resolution when annotations or heights change
	$effect(() => {
		if (!containerElement) return;

		// Force re-run when annotations change (synchronous read for Svelte 5 tracking)
		const annotationCount = annotations.size;
		// Also track height changes
		const _heightsSnapshot = [...editorHeights.entries()];

		if (annotationCount === 0) return;

		// Resolve on next frame
		const frameId = requestAnimationFrame(resolveOverlaps);

		// Watch for resize/scroll (positions change when window resizes or content scrolls)
		const handleChange = () => requestAnimationFrame(resolveOverlaps);
		window.addEventListener('resize', handleChange);
		containerElement.addEventListener('scroll', handleChange, { passive: true });

		return () => {
			cancelAnimationFrame(frameId);
			window.removeEventListener('resize', handleChange);
			containerElement.removeEventListener('scroll', handleChange);
		};
	});

	// Listen for selection changes to detect cursor inside annotations
	$effect(() => {
		if (!containerElement) return;

		const handleSelectionChange = () => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return;

			const anchorNode = selection.anchorNode;
			if (!anchorNode) return;

			// Check if cursor is in content area
			const contentDiv = containerElement.querySelector('.html-annotator-content');
			if (!contentDiv?.contains(anchorNode)) return;

			// Find if cursor is inside an annotation
			const annotationId = findContainingAnnotation(anchorNode);
			if (annotationId !== activeAnnotationId) {
				setActiveAnnotation(annotationId);
			}
		};

		document.addEventListener('selectionchange', handleSelectionChange);
		return () => document.removeEventListener('selectionchange', handleSelectionChange);
	});

	// Focus the content area with cursor at the beginning of an annotation
	function focusAnnotation(annotationId: string) {
		const contentDiv = containerElement?.querySelector('.html-annotator-content') as HTMLElement;
		const annotation = containerElement?.querySelector(`x-annotation[id="${annotationId}"]`);

		if (contentDiv && annotation) {
			contentDiv.focus({ preventScroll: true });
			const range = document.createRange();
			range.setStart(annotation, 0);
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
	}

	// Get annotation IDs sorted by document order
	function getSortedAnnotationIds(): string[] {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (!contentDiv) return [];

		const annotationElements = Array.from(
			contentDiv.querySelectorAll('x-annotation[id]')
		) as HTMLElement[];

		// Sort by document order
		annotationElements.sort((a, b) => {
			const position = a.compareDocumentPosition(b);
			if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
			if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
			return 0;
		});

		return annotationElements.map((el) => el.getAttribute('id')!);
	}

	// Focus next editor (no wrap-around)
	function focusNextEditor(currentId: string) {
		const ids = getSortedAnnotationIds();
		const currentIndex = ids.indexOf(currentId);
		if (currentIndex < ids.length - 1) {
			const nextId = ids[currentIndex + 1];
			editorRefs[currentId]?.deactivate();
			editorRefs[nextId]?.activate();
		}
	}

	// Focus previous editor (no wrap-around)
	function focusPreviousEditor(currentId: string) {
		const ids = getSortedAnnotationIds();
		const currentIndex = ids.indexOf(currentId);
		if (currentIndex > 0) {
			const prevId = ids[currentIndex - 1];
			editorRefs[currentId]?.deactivate();
			editorRefs[prevId]?.activate();
		}
	}

	// Find annotation containing the given node
	function findContainingAnnotation(node: Node): string | null {
		let current: Node | null = node;
		while (current) {
			if (current instanceof HTMLElement && current.tagName.toLowerCase() === 'x-annotation') {
				return current.getAttribute('id') || null;
			}
			current = current.parentNode;
		}
		return null;
	}

	// Set the currently active annotation (toggles 'active' class on DOM element)
	function setActiveAnnotation(id: string | null) {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (!contentDiv) return;

		// Remove 'active' class from previous annotation
		if (activeAnnotationId) {
			const prevAnnotation = contentDiv.querySelector(`x-annotation[id="${activeAnnotationId}"]`);
			prevAnnotation?.classList.remove('active');
		}

		// Add 'active' class to new annotation and scroll to it
		if (id) {
			const newAnnotation = contentDiv.querySelector(`x-annotation[id="${id}"]`);
			newAnnotation?.classList.add('active');
			// Scroll annotation into view (step 1 of activation sequence)
			newAnnotation?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}

		activeAnnotationId = id;
	}

	// Find target annotation for Tab navigation
	function findTargetAnnotation(
		cursorNode: Node | null,
		reverse: boolean,
		ids: string[]
	): string | null {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (!contentDiv) return null;

		// If no cursor, go to first (Tab) or last (Shift+Tab) annotation
		if (!cursorNode) {
			return reverse ? ids[ids.length - 1] : ids[0];
		}

		for (let i = 0; i < ids.length; i++) {
			const idx = reverse ? ids.length - 1 - i : i;
			const annotation = contentDiv.querySelector(`x-annotation[id="${ids[idx]}"]`);
			if (!annotation) continue;

			const position = cursorNode.compareDocumentPosition(annotation);
			if (reverse) {
				// Looking for annotation before cursor
				if (position & Node.DOCUMENT_POSITION_PRECEDING) {
					return ids[idx];
				}
			} else {
				// Looking for annotation after cursor
				if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
					return ids[idx];
				}
			}
		}

		// No annotation found in that direction: stop at edge
		return null;
	}

	// Handle Tab key in content area
	function handleContentKeyDown(event: KeyboardEvent) {
		if (event.key === 'Tab') {
			const ids = getSortedAnnotationIds();
			if (ids.length === 0) return; // No annotations: do nothing

			event.preventDefault();

			// Get cursor position
			const selection = window.getSelection();
			const cursorNode = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;

			// Check if cursor is inside an annotation - if so, activate that editor
			const insideAnnotation = cursorNode ? findContainingAnnotation(cursorNode) : null;
			if (insideAnnotation) {
				editorRefs[insideAnnotation]?.activate(true); // force activation
				return;
			}

			// Find which annotation to navigate to based on cursor position
			const targetId = findTargetAnnotation(cursorNode, event.shiftKey, ids);
			if (targetId) {
				editorRefs[targetId]?.activate();
			}
		}
	}

	// Handle direct editing of content
	function handleContentInput() {
		if (onContentChange && containerElement) {
			const contentDiv = containerElement.querySelector('.html-annotator-content');
			if (contentDiv) {
				onContentChange(contentDiv.innerHTML);
			}
		}
	}

	// Callbacks for CommentEditor
	function handleCloseAnnotation(id: string, restoreSelection: boolean = false) {
		if (!containerElement) return;

		const annotation = containerElement.querySelector(
			`x-annotation[id="${id}"]`
		) as HTMLElement | null;

		if (annotation) {
			const result = removeAnnotation(annotation, containerElement);
			if (onContentChange) {
				onContentChange(result.html);
			}

			// Restore selection if requested (e.g., ESC on empty annotation)
			if (restoreSelection && result.firstNode && result.lastNode) {
				const contentDiv = containerElement.querySelector('.html-annotator-content') as HTMLElement;
				if (contentDiv) {
					contentDiv.focus({ preventScroll: true });
					const range = document.createRange();
					range.setStartBefore(result.firstNode);
					range.setEndAfter(result.lastNode);
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
				}
			}
		}

		// Clear active state if this annotation was active
		if (activeAnnotationId === id) {
			activeAnnotationId = null;
		}

		// Remove from state
		annotations.delete(id);
		editorHeights.delete(id);
		delete editorRefs[id];
	}

	function handleSetContent(id: string, newCommentContent: string) {
		// Update state - modify the last User message or add a new one
		const state = annotations.get(id);
		if (state) {
			const messages = [...state.messages];
			if (messages.length > 0 && messages[messages.length - 1].author === 'User') {
				// Update existing User message
				messages[messages.length - 1] = { author: 'User', content: newCommentContent };
			} else {
				// Add new User message
				messages.push({ author: 'User', content: newCommentContent });
			}
			annotations.set(id, { ...state, messages });
		}

		// Notify parent of content change
		if (onContentChange && containerElement) {
			const contentDiv = containerElement.querySelector('.html-annotator-content');
			if (contentDiv) {
				queueMicrotask(() => {
					onContentChange(contentDiv.innerHTML);
				});
			}
		}
	}

	// Handle selection completion (mouseup or shift keyup)
	function handleSelectionComplete() {
		if (!containerElement) return;

		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;

		// Snap the selection first
		const snapped = doSnapSelection(selection, containerElement);
		if (!snapped) return;

		// Wrap with annotation - this modifies the DOM directly
		const newContent = wrapSelectionWithAnnotation(snapped.range, containerElement);

		// Note: We do NOT call onContentChange here because that would re-render
		// the content and destroy the DOM we just modified. The annotation is
		// already in the DOM and working. We only need to notify parent for
		// state tracking purposes if needed.
		if (newContent && onContentChange) {
			// Use a microtask to avoid interfering with the current DOM state
			queueMicrotask(() => {
				onContentChange(newContent);
			});
		}
	}

	function handleMouseUp() {
		// Small delay to ensure selection is complete
		setTimeout(handleSelectionComplete, 0);
	}

	function handleKeyUp(event: KeyboardEvent) {
		// Only handle shift key release (for keyboard selection)
		if (event.key === 'Shift') {
			handleSelectionComplete();
		}
	}

	// Handle annotation close events
	function handleAnnotationClose(event: CustomEvent<AnnotationCloseDetail>) {
		if (!containerElement) return;

		const { annotation } = event.detail;
		const result = removeAnnotation(annotation, containerElement);
		if (onContentChange) {
			onContentChange(result.html);
		}
	}

	// Exported methods
	export function setAnnotatedHtml(html: string): void {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (contentDiv) {
			// Clear existing annotation state before replacing content
			// NOTE: Do NOT clear editorRefs here! Svelte's bind:this sets refs to null on component
			// destruction, which happens AFTER new components mount. If we clear refs, the destruction
			// of old components will overwrite the new refs with null.
			annotations.clear();
			editorHeights.clear();

			contentDiv.innerHTML = html;
			// Generate id for annotations that don't have one and register them
			contentDiv.querySelectorAll('x-annotation').forEach((el) => {
				if (!el.hasAttribute('id')) {
					el.setAttribute('id', generateAnnotationId());
				}

				// Wrap text nodes with .x-highlight spans for background color (skip x-comment)
				Array.from(el.childNodes).forEach((child) => {
					if (child.nodeName.toLowerCase() !== 'x-comment') {
						if (child.nodeType === Node.TEXT_NODE) {
							if (child.textContent?.trim()) {
								const span = document.createElement('span');
								span.className = 'x-highlight';
								span.textContent = child.textContent;
								child.parentNode?.replaceChild(span, child);
							}
						} else if (child.nodeType === Node.ELEMENT_NODE) {
							wrapTextNodesWithHighlight(child);
						}
					}
				});

				// Manually register annotation since MutationObserver already fired
				const id = el.getAttribute('id');
				if (id && !annotations.has(id)) {
					const commentEl = el.querySelector('x-comment');
					const messages = parseMessages(commentEl);
					// Ensure there's always at least an empty User message for editing
					if (messages.length === 0) {
						messages.push({ author: 'User', content: '' });
					}
					annotations.set(id, {
						id,
						messages,
						resolvedTop: 0
					});
				}
			});
		}
	}

	export function getAnnotatedHtml(): string {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (!contentDiv) return '';

		const clone = contentDiv.cloneNode(true) as Element;

		// Get the original annotations to look up their ids
		const originalAnnotations = contentDiv.querySelectorAll('x-annotation');

		// Process each x-annotation element
		clone.querySelectorAll('x-annotation').forEach((annotation, index) => {
			const originalAnnotation = originalAnnotations[index];
			const annotationId = originalAnnotation?.getAttribute('id');

			// Keep the id attribute (do not remove it)

			// Unwrap all .x-highlight spans (replace with their text content)
			annotation.querySelectorAll('.x-highlight').forEach((span) => {
				const text = document.createTextNode(span.textContent || '');
				span.parentNode?.replaceChild(text, span);
			});

			// Get messages from the annotations state Map
			let messages: Message[] = [];
			if (annotationId) {
				const annotationState = annotations.get(annotationId);
				if (annotationState) {
					messages = annotationState.messages;
				}
			}

			// Remove any existing x-comment in the clone (shouldn't be there, but just in case)
			const existingComment = annotation.querySelector('x-comment');
			if (existingComment) {
				existingComment.remove();
			}

			// Create a clean x-comment element with msg elements
			const newComment = document.createElement('x-comment');
			// Create and add msg elements from messages
			messages.forEach((msg) => {
				const msgEl = document.createElement('msg');
				msgEl.setAttribute('author', msg.author);
				msgEl.innerHTML = msg.content;
				newComment.appendChild(msgEl);
			});
			annotation.appendChild(newComment);
		});

		return clone.innerHTML;
	}

	export function clearSelection(): void {
		window.getSelection()?.removeAllRanges();
	}

	export function snapSelection(): SnappedSelection | null {
		if (!containerElement) return null;
		return doSnapSelection(window.getSelection(), containerElement);
	}

	export function selectRange(range: Range): void {
		const selection = window.getSelection();
		if (selection) {
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}

	export function scrollToElement(selector: string): void {
		const element = containerElement?.querySelector(selector);
		element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	/**
	 * Get the document HTML without x-comment content or x-modified tags.
	 * This is the "clean" document with just x-annotation markers.
	 */
	export function getDocument(): string {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (!contentDiv) return '';

		const clone = contentDiv.cloneNode(true) as Element;

		// Strip x-modified tags (unwrap content, remove del markers)
		stripModifiedTags(clone);

		// Process each x-annotation element
		clone.querySelectorAll('x-annotation').forEach((annotation) => {
			// Unwrap all .x-highlight spans (replace with their text content)
			annotation.querySelectorAll('.x-highlight').forEach((span) => {
				const text = document.createTextNode(span.textContent || '');
				span.parentNode?.replaceChild(text, span);
			});

			// Remove x-comment elements (annotation content is stored separately)
			const existingComment = annotation.querySelector('x-comment');
			if (existingComment) {
				existingComment.remove();
			}
		});

		return clone.innerHTML;
	}

	/**
	 * Set the document HTML, preserving existing annotation states by ID.
	 * The HTML should contain x-annotation markers but no x-comment content.
	 *
	 * @param html - The new document HTML
	 * @param baseHtml - Optional base HTML to compare against. If provided, differences
	 *                   will be highlighted with x-modified tags.
	 */
	export function setDocument(html: string, baseHtml?: string): void {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (!contentDiv) return;

		// Preserve existing annotation states
		const preservedStates = new Map(annotations);

		// Clear current state
		annotations.clear();
		editorHeights.clear();

		// Apply diff highlighting if base HTML is provided, otherwise use html as-is
		contentDiv.innerHTML = baseHtml ? diffHtml(html, baseHtml) : html;

		// Make deleted sections readonly (they represent removed content for visual diff only)
		contentDiv.querySelectorAll('x-modified[type="del"]').forEach((el) => {
			el.setAttribute('contenteditable', 'false');
		});

		// Process annotations in the new HTML
		contentDiv.querySelectorAll('x-annotation').forEach((el) => {
			if (!el.hasAttribute('id')) {
				el.setAttribute('id', generateAnnotationId());
			}

			// Wrap text nodes with .x-highlight spans for background color (skip x-comment and x-modified)
			Array.from(el.childNodes).forEach((child) => {
				const nodeName = child.nodeName.toLowerCase();
				if (nodeName !== 'x-comment' && nodeName !== 'x-modified') {
					if (child.nodeType === Node.TEXT_NODE) {
						if (child.textContent?.trim()) {
							const span = document.createElement('span');
							span.className = 'x-highlight';
							span.textContent = child.textContent;
							child.parentNode?.replaceChild(span, child);
						}
					} else if (child.nodeType === Node.ELEMENT_NODE) {
						wrapTextNodesWithHighlight(child);
					}
				}
			});

			const id = el.getAttribute('id');
			if (id) {
				// Try to preserve existing state, otherwise create new
				const existingState = preservedStates.get(id);
				if (existingState) {
					annotations.set(id, existingState);
				} else {
					// New annotation - start with empty User message
					annotations.set(id, {
						id,
						messages: [{ author: 'User', content: '' }],
						resolvedTop: 0
					});
				}
			}
		});
	}

	/**
	 * Get all annotation IDs in DOM order.
	 */
	export function getAllAnnotationIds(): string[] {
		return getSortedAnnotationIds();
	}

	/**
	 * Get the content of a single annotation.
	 * If this is the active annotation, reads the current editor content directly
	 * to capture unsaved changes without triggering state updates.
	 */
	export function getAnnotation(id: string): AnnotationContent | null {
		const state = annotations.get(id);
		if (!state) return null;

		// Copy messages to avoid mutating state
		let messages = [...state.messages];

		// If this is the active annotation, read current content from the editor
		// This captures unsaved changes without triggering reactive updates
		if (id === activeAnnotationId && editorRefs[id]) {
			const currentContent = editorRefs[id].getCurrentContent();
			// Update or add the last User message with current editor content
			if (messages.length > 0 && messages[messages.length - 1].author === 'User') {
				messages[messages.length - 1] = {
					author: 'User',
					content: currentContent
				};
			} else if (currentContent) {
				messages.push({ author: 'User', content: currentContent });
			}
		}

		return {
			id: state.id,
			messages
		};
	}

	/**
	 * Set the content of a single annotation.
	 * Message content is converted from markdown to HTML for display.
	 */
	export function setAnnotation(id: string, content: AnnotationContent): void {
		const state = annotations.get(id);
		if (state) {
			annotations.set(id, {
				...state,
				messages: convertMessagesToHtml([...content.messages])
			});
		}
	}

	/**
	 * Delete an annotation by ID (removes from DOM and state).
	 */
	export function delAnnotation(id: string): void {
		const contentDiv = containerElement?.querySelector('.html-annotator-content');
		if (!contentDiv) return;

		const annotation = contentDiv.querySelector(`x-annotation[id="${id}"]`);
		if (annotation) {
			const result = removeAnnotation(annotation, containerElement);
			if (onContentChange) {
				onContentChange(result.html);
			}
		}

		// Also remove from state (removeAnnotation triggers MutationObserver which does this,
		// but we do it explicitly for safety)
		annotations.delete(id);
		editorHeights.delete(id);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="html-annotator {className}"
	bind:this={containerElement}
	data-theme={theme}
	onmouseup={handleMouseUp}
	onkeyup={handleKeyUp}
>
	<div class="annotation-sidebar">
		{#each [...annotations.values()] as annotation (annotation.id)}
			<CommentEditor
				bind:this={editorRefs[annotation.id]}
				annotationId={annotation.id}
				messages={annotation.messages}
				top={annotation.resolvedTop}
				onClose={(restoreSelection) => handleCloseAnnotation(annotation.id, restoreSelection)}
				onSetContent={(newContent) => handleSetContent(annotation.id, newContent)}
				onFocusAnnotation={() => focusAnnotation(annotation.id)}
				onFocusNextEditor={() => focusNextEditor(annotation.id)}
				onFocusPreviousEditor={() => focusPreviousEditor(annotation.id)}
				onHeightChange={(height) => {
					editorHeights.set(annotation.id, height);
				}}
				isActive={activeAnnotationId === annotation.id}
				onActiveChange={(active) => setActiveAnnotation(active ? annotation.id : null)}
			/>
		{/each}
	</div>
	<div
		class="html-annotator-content"
		contenteditable="true"
		onkeydown={handleContentKeyDown}
		oninput={handleContentInput}
	></div>
</div>

<style>
	.html-annotator {
		width: 100%;
		height: 100%;
		overflow: auto;
		background-color: var(--color-bg-primary);
		color: var(--color-text-primary);
		font-family: var(--font-family-sans);
		font-size: var(--font-size-base);
		line-height: var(--line-height-relaxed);
		display: flex;
		position: relative;
	}

	.html-annotator-content {
		flex: 5;
		padding: var(--spacing-xl);
		outline: none; /* Remove focus outline */
	}

	.html-annotator-content:focus {
		outline: none; /* Remove focus outline */
	}

	.annotation-sidebar {
		flex: 3;
		position: relative;
		padding: var(--spacing-xl) var(--spacing-md);
		overflow: visible;
	}

	/* Annotation element styling */
	.html-annotator-content :global(x-annotation) {
		text-decoration: underline;
		text-decoration-color: var(--color-annotation-underline);
		text-underline-offset: var(--annotation-underline-offset);
		cursor: pointer;
	}

	/* Highlight spans for line-by-line background coloring */
	.html-annotator-content :global(x-annotation .x-highlight) {
		background-color: var(--color-annotation-bg);
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
	}

	.html-annotator-content :global(x-annotation:hover .x-highlight) {
		background-color: var(--color-annotation-bg-hover);
	}

	/* Active state for annotation - brighter highlight when focused */
	.html-annotator-content :global(x-annotation.active .x-highlight) {
		background-color: var(--color-annotation-bg-active);
	}

	/* Hide comment when inside content area (before/if not moved to sidebar) */
	.html-annotator-content :global(x-comment) {
		display: none !important;
	}

	/* Hide x-comment in sidebar - CommentEditor handles display */
	.annotation-sidebar :global(x-comment) {
		display: none !important;
	}

	/* Selection styling */
	.html-annotator :global(::selection) {
		background-color: var(--color-selection-bg);
		color: var(--color-selection-text);
	}

	/* Darker selection in sidebar for better contrast */
	.annotation-sidebar :global(::selection) {
		background-color: var(--color-editor-selection-bg);
	}

	/* Scrollbar styling */
	.html-annotator::-webkit-scrollbar {
		width: var(--scrollbar-width);
		height: var(--scrollbar-width);
	}

	.html-annotator::-webkit-scrollbar-track {
		background: var(--scrollbar-track);
	}

	.html-annotator::-webkit-scrollbar-thumb {
		background: var(--scrollbar-thumb);
		border-radius: var(--border-radius-sm);
	}

	.html-annotator::-webkit-scrollbar-thumb:hover {
		background: var(--scrollbar-thumb-hover);
	}

	/* Content styling for rendered HTML */
	.html-annotator-content :global(h1) {
		font-size: var(--font-size-3xl);
		font-weight: 600;
		margin-top: var(--spacing-2xl);
		margin-bottom: var(--spacing-md);
		border-bottom: 1px solid var(--color-border);
		padding-bottom: var(--spacing-sm);
	}

	.html-annotator-content :global(h1:first-child) {
		margin-top: 0;
	}

	.html-annotator-content :global(h2) {
		font-size: var(--font-size-2xl);
		font-weight: 600;
		margin-top: var(--spacing-xl);
		margin-bottom: var(--spacing-md);
	}

	.html-annotator-content :global(h3) {
		font-size: var(--font-size-xl);
		font-weight: 600;
		margin-top: var(--spacing-lg);
		margin-bottom: var(--spacing-sm);
	}

	.html-annotator-content :global(h4) {
		font-size: var(--font-size-lg);
		font-weight: 600;
		margin-top: var(--spacing-lg);
		margin-bottom: var(--spacing-sm);
	}

	.html-annotator-content :global(h5) {
		font-size: var(--font-size-base);
		font-weight: 600;
		margin-top: var(--spacing-md);
		margin-bottom: var(--spacing-sm);
	}

	.html-annotator-content :global(h6) {
		font-size: var(--font-size-sm);
		font-weight: 600;
		margin-top: var(--spacing-md);
		margin-bottom: var(--spacing-sm);
		color: var(--color-text-secondary);
	}

	.html-annotator-content :global(p) {
		margin-bottom: var(--spacing-md);
	}

	.html-annotator-content :global(a) {
		color: var(--color-accent-secondary);
		text-decoration: none;
	}

	.html-annotator-content :global(a:hover) {
		text-decoration: underline;
	}

	.html-annotator-content :global(strong),
	.html-annotator-content :global(b) {
		font-weight: 600;
	}

	.html-annotator-content :global(em),
	.html-annotator-content :global(i) {
		font-style: italic;
	}

	.html-annotator-content :global(code) {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
		background-color: var(--color-bg-tertiary);
		padding: 0.1em 0.4em;
		border-radius: var(--border-radius-sm);
	}

	.html-annotator-content :global(pre) {
		background-color: var(--color-bg-secondary);
		padding: var(--spacing-md);
		border-radius: var(--border-radius-md);
		overflow-x: auto;
		margin-bottom: var(--spacing-md);
	}

	.html-annotator-content :global(pre code) {
		background: none;
		padding: 0;
		font-size: var(--font-size-sm);
	}

	.html-annotator-content :global(blockquote) {
		border-left: 4px solid var(--color-accent-primary);
		margin: var(--spacing-md) 0;
		padding-left: var(--spacing-md);
		color: var(--color-text-secondary);
	}

	.html-annotator-content :global(blockquote blockquote) {
		margin-top: var(--spacing-sm);
	}

	.html-annotator-content :global(ul),
	.html-annotator-content :global(ol) {
		margin-bottom: var(--spacing-md);
		padding-left: var(--spacing-xl);
	}

	.html-annotator-content :global(li) {
		margin-bottom: var(--spacing-xs);
	}

	.html-annotator-content :global(li > ul),
	.html-annotator-content :global(li > ol) {
		margin-top: var(--spacing-xs);
		margin-bottom: 0;
	}

	.html-annotator-content :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin-bottom: var(--spacing-md);
	}

	.html-annotator-content :global(th),
	.html-annotator-content :global(td) {
		border: 1px solid var(--color-border);
		padding: var(--spacing-sm) var(--spacing-md);
		text-align: left;
	}

	.html-annotator-content :global(th) {
		background-color: var(--color-bg-secondary);
		font-weight: 600;
	}

	.html-annotator-content :global(tr:nth-child(even)) {
		background-color: var(--color-bg-secondary);
	}

	.html-annotator-content :global(hr) {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: var(--spacing-xl) 0;
	}

	.html-annotator-content :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: var(--border-radius-md);
	}

	.html-annotator-content :global(mark) {
		background-color: var(--color-warning);
		color: var(--color-bg-primary);
		padding: 0.1em 0.2em;
		border-radius: var(--border-radius-sm);
	}

	.html-annotator-content :global(del),
	.html-annotator-content :global(s) {
		text-decoration: line-through;
		color: var(--color-text-muted);
	}

	.html-annotator-content :global(sub) {
		font-size: var(--font-size-xs);
		vertical-align: sub;
	}

	.html-annotator-content :global(sup) {
		font-size: var(--font-size-xs);
		vertical-align: super;
	}

	.html-annotator-content :global(kbd) {
		font-family: var(--font-family-mono);
		font-size: var(--font-size-sm);
		background-color: var(--color-bg-tertiary);
		border: 1px solid var(--color-border);
		border-radius: var(--border-radius-sm);
		padding: 0.1em 0.4em;
		box-shadow: 0 1px 0 var(--color-border);
	}

	.html-annotator-content :global(abbr) {
		text-decoration: underline dotted;
		cursor: help;
	}

	.html-annotator-content :global(details) {
		margin-bottom: var(--spacing-md);
	}

	.html-annotator-content :global(summary) {
		cursor: pointer;
		font-weight: 600;
		margin-bottom: var(--spacing-sm);
	}

	.html-annotator-content :global(figure) {
		margin: var(--spacing-md) 0;
	}

	.html-annotator-content :global(figcaption) {
		font-size: var(--font-size-sm);
		color: var(--color-text-secondary);
		margin-top: var(--spacing-sm);
		text-align: center;
	}
</style>
