/**
 * Custom elements for annotation system
 *
 * These elements work with {@html} in Svelte and can modify their children.
 * Note: Classes are only defined in browser environment (not during SSR).
 */

/**
 * Event detail for annotation close events
 */
export interface AnnotationCloseDetail {
	/** The annotation element being closed */
	annotation: HTMLElement;
}

/**
 * A message in a discussion thread
 */
export interface DiscussionMessage {
	/** The author of the message */
	author: string;
	/** The message content */
	content: string;
}

/**
 * Layout constants for annotation positioning
 */
const COMMENT_PADDING_PX = 8; // Gap between comments in sidebar
const COMMENT_DEFAULT_HEIGHT_PX = 40; // Default comment height if not rendered yet
const COMMENT_RIGHT_OFFSET = '16px'; // Right offset from sidebar edge

// Only define and register custom elements in browser environment
const isBrowser = typeof window !== 'undefined' && typeof HTMLElement !== 'undefined';

// Debounce state for overlap resolution
let resolveOverlapsScheduled = false;
let pendingSidebar: HTMLElement | null = null;

/**
 * Schedule overlap resolution for the next animation frame.
 * Multiple calls within the same frame only trigger one recalculation.
 */
function scheduleResolveOverlaps(sidebar: HTMLElement): void {
	pendingSidebar = sidebar;
	if (!resolveOverlapsScheduled) {
		resolveOverlapsScheduled = true;
		requestAnimationFrame(() => {
			resolveOverlapsScheduled = false;
			if (pendingSidebar) {
				resolveCommentOverlapsImpl(pendingSidebar);
				pendingSidebar = null;
			}
		});
	}
}

/**
 * Resolve overlapping comments by pushing them down.
 * Uses cached annotation lookups to avoid O(n²) DOM queries.
 */
function resolveCommentOverlapsImpl(sidebar: HTMLElement): void {
	const comments = Array.from(sidebar.querySelectorAll('x-comment')) as HTMLElement[];

	// Cache annotation lookups BEFORE sorting to avoid O(n²) queries
	const annotationCache = new Map<string, Element | null>();
	for (const comment of comments) {
		const id = comment.dataset.annotationId;
		if (id && !annotationCache.has(id)) {
			annotationCache.set(id, document.querySelector(`x-annotation[data-id="${id}"]`));
		}
	}

	// Sort by DOM order of annotations (text flow order)
	comments.sort((a, b) => {
		const aAnnotation = annotationCache.get(a.dataset.annotationId || '');
		const bAnnotation = annotationCache.get(b.dataset.annotationId || '');

		if (aAnnotation && bAnnotation) {
			const position = aAnnotation.compareDocumentPosition(bAnnotation);
			if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
			if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		}
		// Fallback to ideal top position
		return parseFloat(a.dataset.idealTop || '0') - parseFloat(b.dataset.idealTop || '0');
	});

	const padding = COMMENT_PADDING_PX;
	let nextAvailableTop = 0;

	for (const comment of comments) {
		const idealTop = parseFloat(comment.dataset.idealTop || '0');
		const actualTop = Math.max(idealTop, nextAvailableTop);
		comment.style.top = `${actualTop}px`;
		const height = comment.offsetHeight || COMMENT_DEFAULT_HEIGHT_PX;
		nextAvailableTop = actualTop + height + padding;
	}
}

/**
 * Register custom elements
 * Safe to call multiple times - will not re-register
 * Only runs in browser environment
 */
export function registerAnnotationElements(): void {
	if (!isBrowser) return;

	if (!customElements.get('x-annotation')) {
		/**
		 * <x-annotation> custom element
		 *
		 * Wraps selected text and contains a <comment> child.
		 * Displays with light blue background and underline.
		 * The comment is shown in a sidebar bubble.
		 */
		customElements.define(
			'x-annotation',
			class extends HTMLElement {
				private resizeObserver: ResizeObserver | null = null;
				private intersectionObserver: IntersectionObserver | null = null;

				connectedCallback() {
					// Use requestAnimationFrame to ensure DOM is fully ready
					requestAnimationFrame(() => {
						// Position the comment element in the sidebar
						this.updateCommentPosition();

						// Watch for layout changes
						this.resizeObserver = new ResizeObserver(() => {
							this.updateCommentPosition();
						});
						this.resizeObserver.observe(this);

						// Also update on scroll of parent containers
						this.setupScrollListeners();
					});
				}

				disconnectedCallback() {
					this.resizeObserver?.disconnect();
					this.intersectionObserver?.disconnect();
					this.removeScrollListeners();
				}

				private scrollHandler = () => {
					this.updateCommentPosition();
				};

				private setupScrollListeners() {
					// Find scrollable ancestors and listen to their scroll events
					let parent = this.parentElement;
					while (parent) {
						if (
							parent.scrollHeight > parent.clientHeight ||
							parent.scrollWidth > parent.clientWidth
						) {
							parent.addEventListener('scroll', this.scrollHandler, { passive: true });
						}
						parent = parent.parentElement;
					}
					window.addEventListener('scroll', this.scrollHandler, { passive: true });
					window.addEventListener('resize', this.scrollHandler, { passive: true });
				}

				private removeScrollListeners() {
					let parent = this.parentElement;
					while (parent) {
						parent.removeEventListener('scroll', this.scrollHandler);
						parent = parent.parentElement;
					}
					window.removeEventListener('scroll', this.scrollHandler);
					window.removeEventListener('resize', this.scrollHandler);
				}

				/**
				 * Update the position of the comment element to align with this annotation
				 */
				private updateCommentPosition() {
					// Find comment - either still inside this annotation or already in sidebar
					let comment = this.querySelector('x-comment') as HTMLElement | null;
					const annotationId = this.dataset.id;

					// If comment not found inside, check if it's already in sidebar
					if (!comment && annotationId) {
						comment = document.querySelector(
							`.annotation-sidebar x-comment[data-annotation-id="${annotationId}"]`
						) as HTMLElement | null;
					}

					if (!comment) return;

					// Find the sidebar container
					const sidebar = this.closest('.html-annotator')?.querySelector('.annotation-sidebar');
					if (!sidebar) return;

					// Get position relative to the html-annotator container
					const annotator = this.closest('.html-annotator');
					if (!annotator) return;

					const annotatorRect = annotator.getBoundingClientRect();
					const annotationRect = this.getBoundingClientRect();

					// Calculate ideal top position relative to annotator
					const idealTop = annotationRect.top - annotatorRect.top + annotator.scrollTop;

					// Move comment to sidebar if not already there
					if (comment.parentElement !== sidebar) {
						// Store reference back to annotation before moving
						comment.dataset.annotationId = annotationId || '';
						sidebar.appendChild(comment);
					}

					// Store the ideal position as a data attribute for sorting
					comment.dataset.idealTop = String(idealTop);

					comment.style.position = 'absolute';
					comment.style.left = '0';
					comment.style.right = COMMENT_RIGHT_OFFSET;

					// Schedule overlap resolution (debounced)
					scheduleResolveOverlaps(sidebar as HTMLElement);
				}

				/**
				 * Set the comment text
				 */
				setComment(text: string) {
					const comment = this.querySelector('x-comment');
					if (comment) {
						// Find or create the content span (not the close button)
						let content = comment.querySelector('.comment-content') as HTMLElement;
						if (!content) {
							content = document.createElement('span');
							content.className = 'comment-content';
							comment.insertBefore(content, comment.firstChild);
						}
						content.textContent = text;
					}
				}

				/**
				 * Get the comment text
				 */
				getComment(): string {
					const content = this.querySelector('x-comment .comment-content');
					return content?.textContent || '';
				}
			}
		);
	}

	if (!customElements.get('x-comment')) {
		/**
		 * <x-comment> custom element
		 *
		 * Positioning anchor for comments within an annotation.
		 * The actual UI is rendered by CommentEditor Svelte component.
		 * This element is hidden but maintains position data for alignment.
		 *
		 * May contain <x-by> elements for discussion threads, followed by
		 * a .comment-content span for the current editable content.
		 */
		customElements.define(
			'x-comment',
			class extends HTMLElement {
				connectedCallback() {
					// Find text nodes that are NOT inside x-by elements and need wrapping
					// x-by elements should be preserved as-is for discussion display
					const textNodesToWrap: Node[] = [];

					for (const node of Array.from(this.childNodes)) {
						// Skip x-by elements - they're part of the discussion
						if (node.nodeType === Node.ELEMENT_NODE) {
							const el = node as Element;
							if (el.tagName.toLowerCase() === 'x-by') {
								continue;
							}
							// Skip if already wrapped in .comment-content
							if (el.classList?.contains('comment-content')) {
								continue;
							}
						}
						// Collect text nodes with content
						if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
							textNodesToWrap.push(node);
						}
					}

					// Wrap collected text nodes in .comment-content if not already present
					if (textNodesToWrap.length > 0 && !this.querySelector('.comment-content')) {
						const content = document.createElement('span');
						content.className = 'comment-content';
						textNodesToWrap.forEach((node) => {
							content.appendChild(node);
						});
						// Append at end (after x-by elements)
						this.appendChild(content);
					}
				}

				disconnectedCallback() {
					// No cleanup needed - close button removed
				}
			}
		);
	}

	if (!customElements.get('x-by')) {
		/**
		 * <x-by> custom element
		 *
		 * Represents a message in a discussion thread within a comment.
		 * The author attribute stores who wrote the message.
		 * Content is stored as text content of the element.
		 */
		customElements.define('x-by', class extends HTMLElement {});
	}

	if (!customElements.get('x-modified')) {
		/**
		 * <x-modified> custom element
		 *
		 * Marks text that has been modified between document versions.
		 * Attributes:
		 *   - type: 'add' | 'change' | 'del'
		 *   - previous: The old text (for 'change' and 'del' types) - used for tooltips and merging
		 *
		 * Display behavior:
		 *   - type="add": Green text color, shows innerHTML content
		 *   - type="change": Blue text color, shows innerHTML content, hover tooltip shows previous text
		 *   - type="del": Red text with strikethrough, shows innerHTML content (formatted deleted text)
		 *
		 * Note: For 'del' type, the innerHTML contains the formatted HTML of the deleted content,
		 * preserving any bold, italic, links, code, etc. The 'previous' attribute contains the
		 * plain text version for compatibility with merging logic.
		 */
		customElements.define('x-modified', class extends HTMLElement {});
	}
}

/**
 * Check if custom elements are registered
 */
export function areAnnotationElementsRegistered(): boolean {
	if (!isBrowser) return false;
	return (
		!!customElements.get('x-annotation') &&
		!!customElements.get('x-comment') &&
		!!customElements.get('x-by') &&
		!!customElements.get('x-modified')
	);
}
