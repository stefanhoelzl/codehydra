/**
 * Selection snapping utilities
 *
 * Ensures text selections never partially select elements.
 * When a selection crosses element boundaries, it expands to include
 * the entire element(s) being crossed.
 */

export interface SnappedSelection {
	/** The snapped range */
	range: Range;
	/** The selected text content */
	text: string;
	/** The HTML content of the selection */
	html: string;
	/** Whether the selection was modified (snapped) */
	wasSnapped: boolean;
}

/**
 * Snap a selection to element boundaries.
 *
 * When a selection partially includes an element (starts outside and ends inside,
 * or vice versa), this function expands the selection to include the entire element.
 *
 * Additionally, selections are snapped to exclude deleted sections (x-modified type="del")
 * - selections cannot start or end within deleted content.
 *
 * @param selection - The browser Selection object
 * @param container - The container element to constrain selection within
 * @returns The snapped selection info, or null if no valid selection
 */
export function snapSelection(
	selection: Selection | null,
	container: HTMLElement
): SnappedSelection | null {
	if (!selection || !selection.rangeCount || selection.isCollapsed) {
		return null;
	}

	const originalRange = selection.getRangeAt(0);

	// Ensure selection is within container
	if (!container.contains(originalRange.commonAncestorContainer)) {
		return null;
	}

	const snappedRange = originalRange.cloneRange();
	let wasSnapped = expandToBoundaries(snappedRange, container);

	// Snap selection to exclude deleted sections (x-modified type="del")
	const deletedSnapped = snapToExcludeDeletedSections(snappedRange);
	if (deletedSnapped === null) {
		// Selection is entirely within a deleted section - invalid
		selection.removeAllRanges();
		return null;
	}
	wasSnapped = wasSnapped || deletedSnapped;

	// Check if range became collapsed after snapping
	if (snappedRange.collapsed) {
		selection.removeAllRanges();
		return null;
	}

	// Apply the snapped range back to the selection
	if (wasSnapped) {
		selection.removeAllRanges();
		selection.addRange(snappedRange);
	}

	return createSnappedResult(snappedRange, wasSnapped);
}

/**
 * Find the x-modified[type="del"] element containing a node, if any.
 */
function findContainingDeletedSection(node: Node): Element | null {
	let current: Node | null = node;
	while (current) {
		if (current.nodeType === Node.ELEMENT_NODE) {
			const el = current as Element;
			if (el.tagName.toLowerCase() === 'x-modified' && el.getAttribute('type') === 'del') {
				return el;
			}
		}
		current = current.parentNode;
	}
	return null;
}

/**
 * Snap a range to exclude deleted sections (x-modified type="del").
 *
 * If selection starts within a deleted section, move start after it.
 * If selection ends within a deleted section, move end before it.
 * If entire selection is within a deleted section, return null (invalid).
 *
 * @param range - The range to modify
 * @returns true if range was modified, false if no change, null if selection is invalid
 */
function snapToExcludeDeletedSections(range: Range): boolean | null {
	const startDeleted = findContainingDeletedSection(range.startContainer);
	const endDeleted = findContainingDeletedSection(range.endContainer);

	// If both start and end are in the same deleted section, selection is entirely within it
	if (startDeleted && endDeleted && startDeleted === endDeleted) {
		return null;
	}

	let modified = false;

	// If start is in a deleted section, move it after that section
	if (startDeleted) {
		range.setStartAfter(startDeleted);
		modified = true;
	}

	// If end is in a deleted section, move it before that section
	if (endDeleted) {
		range.setEndBefore(endDeleted);
		modified = true;
	}

	return modified;
}

/**
 * Check if a range crosses element boundaries in a way that requires snapping.
 *
 * A range needs snapping when:
 * - Start and end are in different parent elements
 * - Start or end is at a partial position within a text node that has element siblings
 */
function needsSnapping(range: Range): boolean {
	const startContainer = range.startContainer;
	const endContainer = range.endContainer;

	// If both in same text node and selecting the entire node, no snapping needed
	if (startContainer === endContainer && startContainer.nodeType === Node.TEXT_NODE) {
		const textLength = startContainer.textContent?.length ?? 0;
		if (range.startOffset === 0 && range.endOffset === textLength) {
			return false;
		}
		// Check if parent has other element children
		const parent = startContainer.parentElement;
		if (parent && hasElementChildren(parent)) {
			// Partial selection in a node that has element siblings
			return true;
		}
		return false;
	}

	// Different containers means potential boundary crossing
	if (startContainer !== endContainer) {
		return true;
	}

	return false;
}

/**
 * Check if an element has any element children (not just text nodes)
 */
function hasElementChildren(element: Element): boolean {
	for (const child of element.childNodes) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			return true;
		}
	}
	return false;
}

/**
 * Expand range to include complete elements at boundaries.
 *
 * The strategy is simple:
 * - If selection starts mid-text in an element, expand to include the entire element
 * - If selection ends mid-text in an element, expand to include the entire element
 * - Find the highest ancestor element (below the common ancestor) that contains the boundary
 *
 * @returns true if the range was modified
 */
function expandToBoundaries(range: Range, _container: HTMLElement): boolean {
	if (!needsSnapping(range)) {
		return false;
	}

	let modified = false;
	const commonAncestor = range.commonAncestorContainer;

	// Get the common ancestor as an element
	const commonAncestorElement =
		commonAncestor.nodeType === Node.ELEMENT_NODE
			? (commonAncestor as Element)
			: commonAncestor.parentElement;

	if (!commonAncestorElement) {
		return false;
	}

	// Get start info
	const startContainer = range.startContainer;
	const startOffset = range.startOffset;

	// Get end info
	const endContainer = range.endContainer;
	const endOffset = range.endOffset;

	// Expand start: find the highest ancestor element below commonAncestor that contains startContainer
	if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
		const startAncestor = findHighestAncestorBelow(startContainer, commonAncestorElement);
		if (startAncestor) {
			range.setStartBefore(startAncestor);
			modified = true;
		}
	} else if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
		// Starting at beginning of text node - check if we need to include parent
		const startParent = startContainer.parentElement;
		if (startParent && startParent !== commonAncestorElement) {
			const startAncestor = findHighestAncestorBelow(startContainer, commonAncestorElement);
			if (startAncestor) {
				range.setStartBefore(startAncestor);
				modified = true;
			}
		}
	}

	// Expand end: find the highest ancestor element below commonAncestor that contains endContainer
	if (endContainer.nodeType === Node.TEXT_NODE) {
		const textLength = endContainer.textContent?.length ?? 0;
		if (endOffset < textLength) {
			const endAncestor = findHighestAncestorBelow(endContainer, commonAncestorElement);
			if (endAncestor) {
				range.setEndAfter(endAncestor);
				modified = true;
			}
		} else if (endOffset === textLength) {
			// Ending at end of text node - check if we need to include parent
			const endParent = endContainer.parentElement;
			if (endParent && endParent !== commonAncestorElement) {
				const endAncestor = findHighestAncestorBelow(endContainer, commonAncestorElement);
				if (endAncestor) {
					range.setEndAfter(endAncestor);
					modified = true;
				}
			}
		}
	}

	return modified;
}

/**
 * Find the highest ancestor element of a node that is still below (a child of) the stopAt element.
 * This gives us the element that should be fully selected.
 */
function findHighestAncestorBelow(node: Node, stopAt: Element): Element | null {
	let current = node.parentElement;
	let highest: Element | null = null;

	while (current && current !== stopAt) {
		highest = current;
		current = current.parentElement;
	}

	return highest;
}

/**
 * Create the snapped selection result object
 */
function createSnappedResult(range: Range, wasSnapped: boolean): SnappedSelection {
	const text = range.toString();

	// Get HTML content
	const fragment = range.cloneContents();
	const div = document.createElement('div');
	div.appendChild(fragment);
	const html = div.innerHTML;

	return {
		range,
		text,
		html,
		wasSnapped
	};
}

/**
 * Generate a unique ID for an annotation using sequential numbers (a-1, a-2, a-3, etc.)
 */
export function generateAnnotationId(): string {
	// Find all existing annotations in the document
	const existingAnnotations = document.querySelectorAll('x-annotation[id^="a-"]');

	// Extract numbers from existing IDs and find the highest
	let maxNum = 0;
	existingAnnotations.forEach((el) => {
		const id = el.getAttribute('id');
		if (id) {
			const num = parseInt(id.substring(2), 10); // Remove "a-" prefix
			if (!isNaN(num) && num > maxNum) {
				maxNum = num;
			}
		}
	});

	// Return next sequential number
	return `a-${maxNum + 1}`;
}

/**
 * Get the HTML content from the container.
 * Prefers the .html-annotator-content div if it exists.
 */
function getContainerHTML(container: HTMLElement): string {
	const contentDiv = container.querySelector('.html-annotator-content');
	return contentDiv ? contentDiv.innerHTML : container.innerHTML;
}

/**
 * Wrap all text nodes in a document fragment with highlight spans.
 * This enables line-by-line background highlighting even when the
 * annotation spans multiple block elements.
 */
export function wrapTextNodesWithHighlight(node: Node): void {
	// Process child nodes (make a copy since we'll be modifying)
	const childNodes = Array.from(node.childNodes);

	for (const child of childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			// Only wrap non-empty text nodes
			if (child.textContent && child.textContent.trim()) {
				const span = document.createElement('span');
				span.className = 'x-highlight';
				span.textContent = child.textContent;
				child.parentNode?.replaceChild(span, child);
			}
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			// Recursively process element children
			wrapTextNodesWithHighlight(child);
		}
	}
}

/**
 * Wrap the current selection with an annotation element.
 *
 * This modifies the DOM directly by wrapping the selected content with
 * <annotation><comment></comment></annotation>
 *
 * @param range - The range to wrap
 * @param container - The container element (for getting updated HTML)
 * @returns The new HTML content of the container, or null if wrapping failed
 */
export function wrapSelectionWithAnnotation(range: Range, container: HTMLElement): string | null {
	if (range.collapsed) {
		return null;
	}

	// Check if selection is already inside an annotation
	const existingAnnotation =
		range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? (range.commonAncestorContainer as Element).closest('x-annotation')
			: range.commonAncestorContainer.parentElement?.closest('x-annotation');

	if (existingAnnotation) {
		// Already annotated, don't double-wrap
		// Clear the selection to provide visual feedback
		window.getSelection()?.removeAllRanges();
		return null;
	}

	// Check if selection contains any annotations (would create nested annotations)
	const tempFragment = range.cloneContents();
	const tempDiv = document.createElement('div');
	tempDiv.appendChild(tempFragment);
	if (tempDiv.querySelector('x-annotation')) {
		// Selection contains annotations, don't allow nesting
		// Clear the selection to provide visual feedback
		window.getSelection()?.removeAllRanges();
		return null;
	}

	try {
		// Create the annotation wrapper
		const annotation = document.createElement('x-annotation');
		annotation.setAttribute('id', generateAnnotationId());

		// Create the comment element
		const comment = document.createElement('x-comment');

		// Extract and wrap the selected content
		const contents = range.extractContents();

		// Wrap all text nodes with highlight spans for line-by-line background
		wrapTextNodesWithHighlight(contents);

		annotation.appendChild(contents);
		annotation.appendChild(comment);

		// Insert the annotation
		range.insertNode(annotation);

		// Clear the selection
		window.getSelection()?.removeAllRanges();

		// Return the updated HTML from the content container
		return getContainerHTML(container);
	} catch (error) {
		// Range manipulation can fail in various edge cases
		console.warn('[Annotation] Failed to wrap selection:', error);
		return null;
	}
}

/**
 * Result from removing an annotation, includes position info for selection restoration.
 */
export interface AnnotationRemovalResult {
	/** The updated HTML content of the container */
	html: string;
	/** The first node of the unwrapped content (for selection restoration) */
	firstNode: Node | null;
	/** The last node of the unwrapped content (for selection restoration) */
	lastNode: Node | null;
}

/**
 * Remove an annotation element, unwrapping its text content.
 *
 * @param annotation - The annotation element to remove
 * @param container - The container element (for getting updated HTML)
 * @returns Result object with HTML and node references for selection restoration
 */
export function removeAnnotation(
	annotation: HTMLElement,
	container: HTMLElement
): AnnotationRemovalResult {
	// Unwrap all highlight spans first - replace with their text content
	const highlightSpans = annotation.querySelectorAll('.x-highlight');
	highlightSpans.forEach((span) => {
		const textNode = document.createTextNode(span.textContent || '');
		span.parentNode?.replaceChild(textNode, span);
	});

	// Get all child nodes except <x-comment>
	const children = Array.from(annotation.childNodes).filter(
		(node) => !(node instanceof HTMLElement && node.tagName.toLowerCase() === 'x-comment')
	);

	// Capture first and last nodes for selection restoration
	const firstNode = children.length > 0 ? children[0] : null;
	const lastNode = children.length > 0 ? children[children.length - 1] : null;

	// Also remove the comment from sidebar if it was moved there
	const annotationId = annotation.getAttribute('id');
	if (annotationId) {
		const sidebarComment = container.querySelector(
			`.annotation-sidebar x-comment[data-annotation-id="${annotationId}"]`
		);
		sidebarComment?.remove();
	}

	// Replace annotation with its non-comment children
	const parent = annotation.parentNode;
	if (parent) {
		children.forEach((child) => {
			parent.insertBefore(child, annotation);
		});
		annotation.remove();
	}

	// Return result with HTML and node references
	return {
		html: getContainerHTML(container),
		firstNode,
		lastNode
	};
}
