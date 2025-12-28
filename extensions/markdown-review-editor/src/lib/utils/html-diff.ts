/**
 * HTML Diff Utilities
 *
 * Compares two HTML documents and generates x-modified tags to visualize changes.
 *
 * ============================================================================
 * PROCESSING ALGORITHM
 * ============================================================================
 *
 * The diff algorithm follows these steps:
 *
 * STEP 1: CHARACTER-LEVEL DIFF
 *   - Run diff-match-patch on raw HTML strings (text + tags as literal characters)
 *   - Output: array of EQUAL/DELETE/INSERT operations
 *
 * STEP 2: BUILD MODIFICATION RANGES
 *   - Convert diff operations to modification objects with positions in both strings
 *   - For deletions: insert the deleted text from oldHtml at the deletion point
 *     so deletions are processed the same way as insertions/changes
 *   - Adjacent DELETE + INSERT become a single "change" modification
 *   - Track: type (add/del/change), positions in newHtml and oldHtml
 *
 * STEP 3: EXPAND "CHANGE" TO WORD BOUNDARIES
 *   - Only for type="change" modifications
 *   - Expand start/end to include complete words
 *   - Word boundary = whitespace or HTML tag boundary (< or >)
 *   - Update both newHtml range and oldHtml range for "previous" attribute
 *
 * STEP 4: MERGE NEARBY MODIFICATIONS (< 20 chars apart)
 *   - Merge if gap < 20 characters AND NOT (both "add" OR both "del")
 *   - Valid merges: add+del, add+change, del+change, change+change → all become "change"
 *   - No merge: add+add stays separate, del+del stays separate
 *   - NEVER merge across block tags (if gap contains a block tag, don't merge)
 *   - Merged "previous" = text content of oldHtml spanning from first to last modification
 *
 * STEP 5: FILTER IGNORABLE CHANGES
 *   - Skip whitespace-only modifications (including <br> treated as whitespace)
 *   - Skip attribute-only changes (change inside <...> that doesn't affect tag name)
 *   - Keep <img> tags with full attribute comparison
 *
 * STEP 6: SNAP TO HTML TAG BOUNDARIES
 *   - If a range start is inside <...>, move to before <
 *   - If a range end is inside <...>, move to after >
 *   - Ensures HTML tags are treated atomically
 *
 * STEP 7: HANDLE TAG INTERSECTIONS
 *   - If modification partially overlaps an inline tag, EXPAND to enclose it
 *   - If modification starts inside an open inline tag context, expand backwards
 *   - If modification ends with unclosed inline tags, expand forwards
 *   - Block tags are NOT expanded across (would be handled by DOM normalization)
 *
 * STEP 8: INSERT X-MODIFIED TAGS
 *   - Insert backwards (high to low position) to preserve positions
 *   - type="del": <x-modified type="del">deletedContent</x-modified>
 *     (content is the deleted text from oldHtml including HTML formatting,
 *      stripModifiedTags removes entire tag including content)
 *   - type="add": <x-modified type="add">newContent</x-modified>
 *   - type="change": <x-modified type="change" previous="oldTextContent">newContent</x-modified>
 *     (previous contains TEXT ONLY, no HTML tags)
 *
 * STEP 9: DOM BLOCK NORMALIZATION
 *   - Parse result into DOM for block-level operations only
 *   - Split x-modified tags that span multiple block elements
 *   - Elevate (add/del ONLY, not change):
 *     <p><x-modified type="add">entire</x-modified></p>
 *     becomes: <x-modified type="add"><p>entire</p></x-modified>
 *     This ensures block decorations (bullets, etc.) display in the right color.
 *
 * ============================================================================
 * X-MODIFIED TAG TYPES
 * ============================================================================
 *
 * - type="add": New content added (green background)
 * - type="del": Deleted content (red strikethrough)
 *   - Contains the actual deleted text from oldHtml including HTML formatting
 *   - stripModifiedTags() removes the entire element including content
 * - type="change": Modified content (blue background)
 *   - "previous" attribute contains the old TEXT content (no HTML tags)
 *   - stripModifiedTags() unwraps, keeping the new content
 *
 * ============================================================================
 * BLOCK ELEMENTS
 * ============================================================================
 *
 * p, div, li, h1-h6, blockquote, pre, ul, ol, table, tr, td, th,
 * section, article, header, footer, main, aside, nav, figure,
 * figcaption, address, form, fieldset, dl, dt, dd
 *
 */

import { diff_match_patch, DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL } from 'diff-match-patch';

// ============================================================================
// Constants
// ============================================================================

/** Gap threshold in characters for merging nearby modifications */
const MERGE_GAP_THRESHOLD = 20;

/** Block-level HTML element tag names */
const BLOCK_ELEMENTS = new Set([
	'p',
	'div',
	'li',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'blockquote',
	'pre',
	'ul',
	'ol',
	'table',
	'tr',
	'td',
	'th',
	'section',
	'article',
	'header',
	'footer',
	'main',
	'aside',
	'nav',
	'figure',
	'figcaption',
	'address',
	'form',
	'fieldset',
	'dl',
	'dt',
	'dd'
]);

/** Void elements that don't have closing tags */
const VOID_ELEMENTS = new Set([
	'br',
	'hr',
	'img',
	'input',
	'meta',
	'link',
	'area',
	'base',
	'col',
	'embed',
	'param',
	'source',
	'track',
	'wbr'
]);

// ============================================================================
// Data Structures
// ============================================================================

/**
 * Represents a modification (add/del/change) in the document.
 */
interface Modification {
	type: 'add' | 'del' | 'change';
	/** Start position in the working HTML string */
	start: number;
	/** End position in the working HTML string */
	end: number;
	/** Start position in oldHtml (for tracking) */
	startInOld: number;
	/** End position in oldHtml (for tracking) */
	endInOld: number;
	/** Text content of old range (no HTML tags) - for del/change "previous" attribute */
	previous: string;
	/** The actual HTML content for 'del' type (from oldHtml with formatting) */
	deletedHtml?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract plain text content from an HTML string (strip all tags).
 */
function extractTextContent(html: string): string {
	return html.replace(/<[^>]*>/g, '');
}

/**
 * Check if a position is inside an HTML tag (<...>).
 * Returns true if pos is between < and > (exclusive of the brackets themselves).
 */
function isInsideTag(html: string, pos: number): boolean {
	// Scan backwards to find < or >
	for (let i = pos - 1; i >= 0; i--) {
		if (html[i] === '>') return false;
		if (html[i] === '<') return true;
	}
	return false;
}

/**
 * Find the boundaries of the HTML tag containing the given position.
 * Returns null if position is not inside a tag.
 */
function findTagBoundaries(html: string, pos: number): { start: number; end: number } | null {
	if (!isInsideTag(html, pos)) return null;

	let start = pos;
	while (start > 0 && html[start - 1] !== '<') {
		start--;
	}
	start--; // Include the <

	let end = pos;
	while (end < html.length && html[end] !== '>') {
		end++;
	}
	end++; // Include the >

	return { start, end };
}

/**
 * Find word boundary to the left of position.
 * Stops at whitespace or > (end of HTML tag).
 */
function findWordBoundaryLeft(html: string, pos: number): number {
	let i = pos;
	while (i > 0) {
		const char = html[i - 1];
		if (/\s/.test(char) || char === '>') {
			break;
		}
		i--;
	}
	return i;
}

/**
 * Find word boundary to the right of position.
 * Stops at whitespace, < (start of HTML tag), or > (end of HTML tag).
 */
function findWordBoundaryRight(html: string, pos: number): number {
	let i = pos;
	while (i < html.length) {
		const char = html[i];
		if (/\s/.test(char) || char === '<' || char === '>') {
			break;
		}
		i++;
	}
	return i;
}

/**
 * Check if content is whitespace-only (spaces, tabs, newlines, <br> tags).
 */
function isWhitespaceOnly(content: string): boolean {
	// Remove <br> tags (treated as whitespace)
	const withoutBr = content.replace(/<br\s*\/?>/gi, '');
	// Check if only whitespace remains
	return withoutBr.trim() === '';
}

/**
 * Check if a modification is an attribute-only change.
 * True if the change is entirely within <...> and doesn't affect the tag name.
 * Uses the old and new content directly rather than positions.
 *
 * Note: img tag attribute changes are NOT ignored (they should be shown as changes).
 */
function isAttributeOnlyChange(oldContent: string, newContent: string): boolean {
	// Both must look like they're parts of tag attributes (no < or > inside, but context matters)
	// The content itself should not contain < or > (which would indicate tag boundaries)
	if (oldContent.includes('<') || oldContent.includes('>')) return false;
	if (newContent.includes('<') || newContent.includes('>')) return false;

	// Check if both are empty or just whitespace differences
	if (oldContent.trim() === '' && newContent.trim() === '') return false;

	// Check for img tag - img attribute changes should NOT be ignored
	// Look for patterns like 'src="...' which indicates an img attribute
	if (/\bsrc\s*=/.test(oldContent) || /\bsrc\s*=/.test(newContent)) {
		return false;
	}

	// For now, check if content looks like it's inside a tag definition
	// If it contains = with quotes, it's likely an attribute
	const looksLikeAttr = (s: string) => {
		// Contains = with quotes, typical of attributes
		return /=\s*["']/.test(s) || /["']\s*$/.test(s) || /^\s*["']/.test(s);
	};

	if (looksLikeAttr(oldContent) && looksLikeAttr(newContent)) {
		return true;
	}

	return false;
}

/**
 * Check if a string contains any block-level HTML tags.
 */
function containsBlockTag(html: string): boolean {
	const tagRegex = /<\/?([a-zA-Z][\w-]*)/g;
	let match;
	while ((match = tagRegex.exec(html)) !== null) {
		const tagName = match[1].toLowerCase();
		if (BLOCK_ELEMENTS.has(tagName)) {
			return true;
		}
	}
	return false;
}

/**
 * Escape HTML special characters for use in attribute values.
 */
function escapeHtmlAttr(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Check if an element is a block-level element.
 */
function isBlockElement(el: Element): boolean {
	return BLOCK_ELEMENTS.has(el.tagName.toLowerCase());
}

// ============================================================================
// Core Algorithm Functions
// ============================================================================

/**
 * Step 1 & 2: Compute character-level diff and build modification ranges.
 * Also builds an intermediate HTML string with deletions inserted.
 */
function buildModifications(
	oldHtml: string,
	newHtml: string
): { modifications: Modification[]; workingHtml: string } {
	const dmp = new diff_match_patch();
	const diffs = dmp.diff_main(oldHtml, newHtml, false);
	dmp.diff_cleanupSemantic(diffs);

	const modifications: Modification[] = [];
	let workingHtml = '';
	let oldPos = 0;
	let workingPos = 0;

	let i = 0;
	while (i < diffs.length) {
		const [op, text] = diffs[i];

		if (op === DIFF_EQUAL) {
			workingHtml += text;
			oldPos += text.length;
			workingPos += text.length;
			i++;
		} else if (op === DIFF_DELETE) {
			// Check if next is INSERT (making this a CHANGE)
			const next = diffs[i + 1];
			if (next && next[0] === DIFF_INSERT) {
				// CHANGE: delete followed by insert
				const oldText = text;
				const newText = next[1];

				modifications.push({
					type: 'change',
					start: workingPos,
					end: workingPos + newText.length,
					startInOld: oldPos,
					endInOld: oldPos + oldText.length,
					previous: extractTextContent(oldText)
				});

				workingHtml += newText;
				oldPos += oldText.length;
				workingPos += newText.length;
				i += 2;
			} else {
				// Pure DELETE: insert deleted content into working HTML
				modifications.push({
					type: 'del',
					start: workingPos,
					end: workingPos + text.length,
					startInOld: oldPos,
					endInOld: oldPos + text.length,
					previous: extractTextContent(text),
					deletedHtml: text
				});

				workingHtml += text; // Insert deleted content
				oldPos += text.length;
				workingPos += text.length;
				i++;
			}
		} else if (op === DIFF_INSERT) {
			// Pure INSERT
			modifications.push({
				type: 'add',
				start: workingPos,
				end: workingPos + text.length,
				startInOld: oldPos,
				endInOld: oldPos,
				previous: ''
			});

			workingHtml += text;
			workingPos += text.length;
			i++;
		} else {
			i++;
		}
	}

	return { modifications, workingHtml };
}

/**
 * Step 3: Expand "change" modifications to word boundaries.
 */
function expandChangeToWordBoundaries(
	modifications: Modification[],
	workingHtml: string,
	oldHtml: string
): Modification[] {
	return modifications.map((mod) => {
		if (mod.type !== 'change') return mod;

		// Expand start to word boundary
		const newStart = findWordBoundaryLeft(workingHtml, mod.start);
		const startDelta = mod.start - newStart;

		// Expand end to word boundary
		const newEnd = findWordBoundaryRight(workingHtml, mod.end);
		const endDelta = newEnd - mod.end;

		if (startDelta === 0 && endDelta === 0) return mod;

		// Calculate new old positions
		const newStartInOld = Math.max(0, mod.startInOld - startDelta);
		const newEndInOld = Math.min(oldHtml.length, mod.endInOld + endDelta);

		// Update previous with expanded old content
		const newPrevious = extractTextContent(oldHtml.slice(newStartInOld, newEndInOld));

		return {
			...mod,
			start: newStart,
			end: newEnd,
			startInOld: newStartInOld,
			endInOld: newEndInOld,
			previous: newPrevious
		};
	});
}

/**
 * Step 4: Merge nearby modifications (< 20 chars apart).
 * Does not merge if both are "add" or both are "del".
 * Does not merge across block tags.
 */
function mergeNearbyModifications(
	modifications: Modification[],
	workingHtml: string,
	_oldHtml: string
): Modification[] {
	if (modifications.length <= 1) return modifications;

	// Sort by start position
	const sorted = [...modifications].sort((a, b) => a.start - b.start);

	const result: Modification[] = [];
	let current = sorted[0];

	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i];
		const gap = next.start - current.end;

		// Check if we should merge
		const bothAdd = current.type === 'add' && next.type === 'add';
		const bothDel = current.type === 'del' && next.type === 'del';
		const gapContent = workingHtml.slice(current.end, next.start);
		const hasBlockTag = containsBlockTag(gapContent);

		if (gap < MERGE_GAP_THRESHOLD && !bothAdd && !bothDel && !hasBlockTag) {
			// Merge: create a change that spans both
			const mergedStartInOld = Math.min(current.startInOld, next.startInOld);
			const mergedEndInOld = Math.max(current.endInOld, next.endInOld);

			// For the gap between modifications in oldHtml, we need to calculate it properly
			// The gap in oldHtml corresponds to the same text as the gap in workingHtml
			// But we need to account for deletions/insertions
			const gapTextContent = extractTextContent(gapContent);

			current = {
				type: 'change',
				start: current.start,
				end: next.end,
				startInOld: mergedStartInOld,
				endInOld: mergedEndInOld,
				previous: current.previous + gapTextContent + next.previous
			};
		} else {
			result.push(current);
			current = next;
		}
	}
	result.push(current);

	return result;
}

/**
 * Step 5: Filter out ignorable changes (whitespace-only, attribute-only).
 */
function filterIgnorableChanges(
	modifications: Modification[],
	workingHtml: string,
	oldHtml: string,
	_newHtml: string
): Modification[] {
	return modifications.filter((mod) => {
		const content = workingHtml.slice(mod.start, mod.end);

		// Check whitespace-only
		if (mod.type === 'add') {
			if (isWhitespaceOnly(content)) return false;
		} else if (mod.type === 'del') {
			if (isWhitespaceOnly(mod.deletedHtml || content)) return false;
		} else if (mod.type === 'change') {
			const oldContent = oldHtml.slice(mod.startInOld, mod.endInOld);
			if (isWhitespaceOnly(content) && isWhitespaceOnly(oldContent)) return false;

			// Check attribute-only change
			if (isAttributeOnlyChange(oldContent, content)) {
				return false;
			}
		}

		return true;
	});
}

/**
 * Step 6: Snap modification ranges to HTML tag boundaries.
 */
function snapToTagBoundaries(modifications: Modification[], workingHtml: string): Modification[] {
	return modifications.map((mod) => {
		let { start, end } = mod;

		// Snap start outward if inside a tag
		const startTagBounds = findTagBoundaries(workingHtml, start);
		if (startTagBounds) {
			start = startTagBounds.start;
		}

		// Snap end outward if inside a tag
		const endTagBounds = findTagBoundaries(workingHtml, end);
		if (endTagBounds) {
			end = endTagBounds.end;
		}

		if (start === mod.start && end === mod.end) return mod;

		return { ...mod, start, end };
	});
}

/**
 * Step 7: Handle tag intersections by expanding or splitting modifications.
 * First tries to expand the range to enclose partially-overlapping inline tags.
 * Only splits if the range would cross block tag boundaries.
 */
function handleTagIntersections(
	modifications: Modification[],
	workingHtml: string
): Modification[] {
	return modifications.map((mod) => {
		// Try to expand range to enclose any intersecting inline tags
		const expanded = expandToEncloseInlineTags(workingHtml, mod.start, mod.end);
		return { ...mod, start: expanded.start, end: expanded.end };
	});
}

/**
 * Expand a range to fully enclose any inline tags it partially overlaps.
 * If the range starts inside an open tag context, expand backwards to include the opening tag.
 * If the range ends with unclosed tags, expand forwards to include the closing tags.
 */
function expandToEncloseInlineTags(
	html: string,
	start: number,
	end: number
): { start: number; end: number } {
	let newStart = start;
	let newEnd = end;

	// Build stack of open tags before our range
	const beforeContent = html.slice(0, start);
	const openTagsBefore: { tagName: string; pos: number; tagEnd: number }[] = [];
	const beforeTagRegex = /<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?\/?>/g;
	let match;

	while ((match = beforeTagRegex.exec(beforeContent)) !== null) {
		const fullTag = match[0];
		const tagName = match[1].toLowerCase();

		if (VOID_ELEMENTS.has(tagName) || fullTag.endsWith('/>')) {
			continue;
		}

		if (fullTag.startsWith('</')) {
			// Closing tag
			if (
				openTagsBefore.length > 0 &&
				openTagsBefore[openTagsBefore.length - 1].tagName === tagName
			) {
				openTagsBefore.pop();
			}
		} else {
			// Opening tag
			openTagsBefore.push({
				tagName,
				pos: match.index,
				tagEnd: match.index + fullTag.length
			});
		}
	}

	// Check content within our range for closing tags that match openTagsBefore
	const content = html.slice(start, end);
	const tagRegex = /<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?\/?>/g;
	const openedInRange: { tagName: string; pos: number }[] = [];

	while ((match = tagRegex.exec(content)) !== null) {
		const fullTag = match[0];
		const tagName = match[1].toLowerCase();

		if (VOID_ELEMENTS.has(tagName) || fullTag.endsWith('/>')) {
			continue;
		}

		if (fullTag.startsWith('</')) {
			// Closing tag
			if (openedInRange.length > 0 && openedInRange[openedInRange.length - 1].tagName === tagName) {
				// Closed something we opened within range - balanced
				openedInRange.pop();
			} else if (
				openTagsBefore.length > 0 &&
				openTagsBefore[openTagsBefore.length - 1].tagName === tagName
			) {
				// Closing a tag opened before our range
				// Expand start to include the opening tag (only for inline tags)
				const openingTag = openTagsBefore.pop()!;
				if (!BLOCK_ELEMENTS.has(tagName)) {
					newStart = Math.min(newStart, openingTag.pos);
				}
			}
		} else {
			// Opening tag
			openedInRange.push({ tagName, pos: start + match.index });
		}
	}

	// Any tags opened in range but not closed - need to find and include closing tags
	for (const unclosed of openedInRange) {
		if (BLOCK_ELEMENTS.has(unclosed.tagName)) {
			continue; // Don't expand across block tags
		}

		// Find the closing tag after our range
		const closingTagPattern = new RegExp(`</${unclosed.tagName}\\s*>`, 'gi');
		const afterContent = html.slice(end);
		const closingMatch = closingTagPattern.exec(afterContent);
		if (closingMatch) {
			newEnd = Math.max(newEnd, end + closingMatch.index + closingMatch[0].length);
		}
	}

	return { start: newStart, end: newEnd };
}

/**
 * Step 8: Insert x-modified tags into the working HTML.
 */
function insertModificationTags(workingHtml: string, modifications: Modification[]): string {
	// Sort by start position descending (insert backwards)
	const sorted = [...modifications].sort((a, b) => b.start - a.start);

	let result = workingHtml;

	for (const mod of sorted) {
		const content = result.slice(mod.start, mod.end);
		let tag: string;

		if (mod.type === 'del') {
			// For del, we use the deletedHtml (original content from oldHtml)
			const delContent = mod.deletedHtml || content;
			tag = `<x-modified type="del">${delContent}</x-modified>`;
		} else if (mod.type === 'add') {
			tag = `<x-modified type="add">${content}</x-modified>`;
		} else {
			// change
			const escapedPrevious = escapeHtmlAttr(mod.previous);
			tag = `<x-modified type="change" previous="${escapedPrevious}">${content}</x-modified>`;
		}

		result = result.slice(0, mod.start) + tag + result.slice(mod.end);
	}

	return result;
}

/**
 * Step 9: DOM-based block normalization.
 */
function normalizeBlocks(html: string): string {
	const container = document.createElement('div');
	container.innerHTML = html;

	// Split x-modified tags that span multiple block elements
	splitModifiedAtBlockBoundaries(container);

	// Elevate x-modified (add/del only) that wrap entire block content
	elevateBlockModifications(container);

	return container.innerHTML;
}

/**
 * Split x-modified tags that contain multiple block elements.
 */
function splitModifiedAtBlockBoundaries(root: Element): void {
	let modified = true;
	while (modified) {
		modified = false;
		const modifiedElements = root.querySelectorAll('x-modified');

		for (const modEl of modifiedElements) {
			const blockChildren = findDirectBlockChildren(modEl);

			if (blockChildren.length > 1 || (blockChildren.length === 1 && hasNonBlockContent(modEl))) {
				// Need to split
				splitAroundBlocks(modEl, blockChildren);
				modified = true;
				break;
			}
		}
	}
}

/**
 * Find direct block-level children of an element.
 */
function findDirectBlockChildren(el: Element): Element[] {
	const blocks: Element[] = [];
	for (const child of el.children) {
		if (isBlockElement(child)) {
			blocks.push(child);
		} else {
			// Check for nested blocks
			const nested = findNestedBlocks(child);
			blocks.push(...nested);
		}
	}
	return blocks;
}

/**
 * Find nested block elements within an inline element.
 */
function findNestedBlocks(el: Element): Element[] {
	const blocks: Element[] = [];
	for (const child of el.children) {
		if (isBlockElement(child)) {
			blocks.push(child);
		} else {
			blocks.push(...findNestedBlocks(child));
		}
	}
	return blocks;
}

/**
 * Check if element has non-block content (text or inline elements).
 */
function hasNonBlockContent(el: Element): boolean {
	for (const child of el.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			if (child.textContent && child.textContent.trim()) {
				return true;
			}
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const childEl = child as Element;
			if (!isBlockElement(childEl)) {
				if (childEl.textContent && childEl.textContent.trim()) {
					return true;
				}
			}
		}
	}
	return false;
}

/**
 * Split an x-modified element around block children.
 */
function splitAroundBlocks(modEl: Element, blockChildren: Element[]): void {
	const parent = modEl.parentNode;
	if (!parent) return;

	const type = modEl.getAttribute('type') || 'change';
	const previous = modEl.getAttribute('previous') || '';

	// Move all children out and wrap blocks individually
	const children = Array.from(modEl.childNodes);
	const fragment = document.createDocumentFragment();

	let currentInlineGroup: Node[] = [];

	const flushInlineGroup = () => {
		if (currentInlineGroup.length > 0 && hasContentNodes(currentInlineGroup)) {
			const wrapper = createModifiedWrapper(type, previous);
			for (const node of currentInlineGroup) {
				wrapper.appendChild(node);
			}
			fragment.appendChild(wrapper);
		} else {
			for (const node of currentInlineGroup) {
				fragment.appendChild(node);
			}
		}
		currentInlineGroup = [];
	};

	for (const child of children) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			const childEl = child as Element;
			if (isBlockElement(childEl) || blockChildren.includes(childEl)) {
				flushInlineGroup();
				const wrapper = createModifiedWrapper(type, previous);
				wrapper.appendChild(child);
				fragment.appendChild(wrapper);
			} else if (findNestedBlocks(childEl).length > 0) {
				flushInlineGroup();
				fragment.appendChild(child);
			} else {
				currentInlineGroup.push(child);
			}
		} else {
			currentInlineGroup.push(child);
		}
	}
	flushInlineGroup();

	parent.replaceChild(fragment, modEl);
}

/**
 * Check if nodes array has meaningful content.
 */
function hasContentNodes(nodes: Node[]): boolean {
	for (const node of nodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			if (node.textContent && node.textContent.trim()) {
				return true;
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			if ((node as Element).textContent?.trim()) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Create an x-modified wrapper element.
 */
function createModifiedWrapper(type: string, previous: string): Element {
	const wrapper = document.createElement('x-modified');
	wrapper.setAttribute('type', type);
	if (previous && (type === 'del' || type === 'change')) {
		wrapper.setAttribute('previous', previous);
	}
	return wrapper;
}

/**
 * Elevate x-modified (add/del only) that wrap entire block content.
 */
function elevateBlockModifications(root: Element): void {
	const blockSelector = Array.from(BLOCK_ELEMENTS).join(',');
	const blockElements = root.querySelectorAll(blockSelector);

	for (const block of blockElements) {
		// Skip if already wrapped by x-modified
		if (block.parentElement?.tagName.toLowerCase() === 'x-modified') {
			continue;
		}

		const modEl = getOnlyChildModified(block);
		if (modEl) {
			const type = modEl.getAttribute('type');
			// Only elevate add and del, not change
			if (type === 'add' || type === 'del') {
				liftModifiedAroundBlock(block, modEl);
			}
		}
	}
}

/**
 * Get the single x-modified child if it's the only meaningful content.
 */
function getOnlyChildModified(block: Element): Element | null {
	let foundModified: Element | null = null;

	for (const child of block.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			if (child.textContent && child.textContent.trim()) {
				return null; // Has other text content
			}
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const el = child as Element;
			if (el.tagName.toLowerCase() === 'x-modified') {
				if (foundModified) {
					return null; // Multiple x-modified
				}
				foundModified = el;
			} else {
				return null; // Has other elements
			}
		}
	}

	// Verify the x-modified contains the entire block's text
	if (foundModified) {
		const blockText = block.textContent?.trim() || '';
		const modText = foundModified.textContent?.trim() || '';
		if (blockText === modText) {
			return foundModified;
		}
	}

	return null;
}

/**
 * Lift an x-modified element to wrap its parent block.
 */
function liftModifiedAroundBlock(block: Element, modEl: Element): void {
	const parent = block.parentNode;
	if (!parent) return;

	const type = modEl.getAttribute('type') || 'add';
	const previous = modEl.getAttribute('previous') || '';

	// Unwrap the x-modified inside the block
	while (modEl.firstChild) {
		block.insertBefore(modEl.firstChild, modEl);
	}
	block.removeChild(modEl);

	// Wrap the block with x-modified
	const wrapper = createModifiedWrapper(type, previous);
	parent.insertBefore(wrapper, block);
	wrapper.appendChild(block);
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Compare two HTML strings and return HTML with x-modified markers showing differences.
 *
 * @param newHtml - The new (modified) HTML string
 * @param oldHtml - The old (original) HTML string
 * @returns HTML string with x-modified tags marking changes
 */
export function diffHtml(newHtml: string, oldHtml: string): string {
	// Early exit if identical
	if (newHtml === oldHtml) {
		return newHtml;
	}

	// Step 1 & 2: Build modifications and working HTML
	const buildResult = buildModifications(oldHtml, newHtml);
	const workingHtml = buildResult.workingHtml;
	let modifications = buildResult.modifications;

	if (modifications.length === 0) {
		return newHtml;
	}

	// Step 3: Expand "change" to word boundaries
	modifications = expandChangeToWordBoundaries(modifications, workingHtml, oldHtml);

	// Step 4: Merge nearby modifications
	modifications = mergeNearbyModifications(modifications, workingHtml, oldHtml);

	// Step 5: Filter ignorable changes
	modifications = filterIgnorableChanges(modifications, workingHtml, oldHtml, newHtml);

	if (modifications.length === 0) {
		return newHtml;
	}

	// Step 6: Snap to tag boundaries
	modifications = snapToTagBoundaries(modifications, workingHtml);

	// Step 7: Handle tag intersections (expand or split)
	modifications = handleTagIntersections(modifications, workingHtml);

	// Step 8: Insert x-modified tags
	let result = insertModificationTags(workingHtml, modifications);

	// Step 9: DOM block normalization
	result = normalizeBlocks(result);

	return result;
}

// ============================================================================
// Strip Modified Tags
// ============================================================================

/**
 * Remove all x-modified tags from an element.
 * For 'del' type, removes the element entirely (including content).
 * For 'add' and 'change' types, unwraps the content.
 */
export function stripModifiedTags(root: Element): void {
	const modifiedElements = root.querySelectorAll('x-modified');

	// Process in reverse DOM order to avoid issues with nested elements
	const elements = Array.from(modifiedElements).reverse();

	for (const el of elements) {
		const type = el.getAttribute('type');
		const parent = el.parentNode;

		if (!parent) continue;

		if (type === 'del') {
			// Remove deletion markers entirely (including content)
			parent.removeChild(el);
		} else {
			// Unwrap: replace element with its content
			while (el.firstChild) {
				parent.insertBefore(el.firstChild, el);
			}
			parent.removeChild(el);
		}
	}
}
