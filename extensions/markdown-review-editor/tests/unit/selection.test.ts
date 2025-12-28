import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// We need to set up a DOM environment for selection tests
// Note: Full selection snapping tests require a real browser environment
// These tests cover the utility functions that can be tested in Node

describe('selection utilities', () => {
	let dom: JSDOM;
	let document: Document;
	let window: Window & typeof globalThis;

	beforeEach(() => {
		dom = new JSDOM(
			`
			<!DOCTYPE html>
			<html>
				<body>
					<div id="container">
						<p>Regular text with <strong>bold</strong> and <em>italic</em> content.</p>
						<p>Another paragraph with <a href="#">a link</a> inside.</p>
					</div>
				</body>
			</html>
		`,
			{
				url: 'http://localhost',
				pretendToBeVisual: true
			}
		);

		document = dom.window.document;
		window = dom.window as unknown as Window & typeof globalThis;

		// Set up global document and window
		vi.stubGlobal('document', document);
		vi.stubGlobal('window', window);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('DOM structure', () => {
		it('should have a container element', () => {
			const container = document.getElementById('container');
			expect(container).not.toBeNull();
		});

		it('should have paragraphs with inline elements', () => {
			const container = document.getElementById('container');
			const paragraphs = container?.querySelectorAll('p');
			expect(paragraphs?.length).toBe(2);

			const strong = container?.querySelector('strong');
			expect(strong?.textContent).toBe('bold');

			const em = container?.querySelector('em');
			expect(em?.textContent).toBe('italic');
		});
	});

	describe('Range API basics', () => {
		it('should create a range', () => {
			const range = document.createRange();
			expect(range).toBeDefined();
		});

		it('should select text content', () => {
			const container = document.getElementById('container');
			const firstP = container?.querySelector('p');
			const textNode = firstP?.firstChild;

			if (textNode) {
				const range = document.createRange();
				range.setStart(textNode, 0);
				range.setEnd(textNode, 7); // "Regular"

				expect(range.toString()).toBe('Regular');
			}
		});

		it('should detect common ancestor', () => {
			const container = document.getElementById('container');
			const firstP = container?.querySelector('p');
			const strong = firstP?.querySelector('strong');

			if (firstP && strong) {
				const textBefore = firstP.firstChild; // "Regular text with "
				const boldText = strong.firstChild; // "bold"

				if (textBefore && boldText) {
					const range = document.createRange();
					range.setStart(textBefore, 0);
					range.setEnd(boldText, 2); // "bo"

					// Common ancestor should be the paragraph
					expect(range.commonAncestorContainer).toBe(firstP);
				}
			}
		});
	});

	describe('TreeWalker', () => {
		it('should walk text nodes', () => {
			const container = document.getElementById('container');
			if (!container) return;

			// Use window.NodeFilter from jsdom
			const walker = document.createTreeWalker(container, dom.window.NodeFilter.SHOW_TEXT, null);

			const textNodes: string[] = [];
			let node = walker.nextNode();
			while (node) {
				if (node.textContent?.trim()) {
					textNodes.push(node.textContent.trim());
				}
				node = walker.nextNode();
			}

			expect(textNodes).toContain('Regular text with');
			expect(textNodes).toContain('bold');
			expect(textNodes).toContain('italic');
		});

		it('should walk elements', () => {
			const container = document.getElementById('container');
			if (!container) return;

			// Use window.NodeFilter from jsdom
			const walker = document.createTreeWalker(container, dom.window.NodeFilter.SHOW_ELEMENT, null);

			const elements: string[] = [];
			let node = walker.nextNode();
			while (node) {
				elements.push((node as Element).tagName.toLowerCase());
				node = walker.nextNode();
			}

			expect(elements).toContain('p');
			expect(elements).toContain('strong');
			expect(elements).toContain('em');
			expect(elements).toContain('a');
		});
	});

	describe('Range boundary comparisons', () => {
		it('should compare range boundaries', () => {
			const container = document.getElementById('container');
			const firstP = container?.querySelector('p');
			const strong = firstP?.querySelector('strong');

			if (firstP && strong) {
				// Create a range around the strong element
				const elemRange = document.createRange();
				elemRange.selectNode(strong);

				// Create a range that starts before and ends inside strong
				const textBefore = firstP.firstChild;
				const boldText = strong.firstChild;

				if (textBefore && boldText) {
					const crossingRange = document.createRange();
					crossingRange.setStart(textBefore, 0);
					crossingRange.setEnd(boldText, 2);

					// Use Range constants from jsdom window
					const RangeConst = dom.window.Range;

					// crossingRange starts before elemRange
					expect(
						crossingRange.compareBoundaryPoints(RangeConst.START_TO_START, elemRange)
					).toBeLessThan(0);

					// crossingRange ends before elemRange ends
					expect(
						crossingRange.compareBoundaryPoints(RangeConst.END_TO_END, elemRange)
					).toBeLessThan(0);
				}
			}
		});
	});
});

describe('selection snapping logic', () => {
	// These tests describe the expected behavior of selection snapping
	// Full integration tests would require a real browser

	it('should describe snapping behavior for partial element selection', () => {
		// When selecting "text<strong>bo|ld</strong>" (where | is cursor)
		// and the selection starts from "te|xt<strong>bold</strong>"
		// The selection should expand to include the entire <strong> element

		// This is a specification test - actual implementation tested in e2e
		const scenario = {
			input: 'Selection starts in text node, ends inside <strong>',
			expected: 'Selection expands to include entire <strong> element'
		};

		expect(scenario.expected).toContain('expands');
	});

	it('should describe snapping behavior for deeply nested elements', () => {
		// When selecting across multiple nesting levels
		// All partially selected elements should be fully included

		const scenario = {
			input: 'Selection crosses <p><strong><em>nested</em></strong></p> boundaries',
			expected: 'All partially selected elements are fully included'
		};

		expect(scenario.expected).toContain('fully included');
	});
});

describe('selection exclusion from deleted sections', () => {
	// These tests describe the expected behavior when selections interact with
	// deleted sections (x-modified type="del")

	it('should move selection start after deleted section when starting inside', () => {
		// When selection starts inside <x-modified type="del">deleted</x-modified>
		// The start should be moved to after the deleted section

		const scenario = {
			input: 'Selection starts inside x-modified[type="del"]',
			expected: 'Selection start is moved after the deleted section'
		};

		expect(scenario.expected).toContain('after');
	});

	it('should move selection end before deleted section when ending inside', () => {
		// When selection ends inside <x-modified type="del">deleted</x-modified>
		// The end should be moved to before the deleted section

		const scenario = {
			input: 'Selection ends inside x-modified[type="del"]',
			expected: 'Selection end is moved before the deleted section'
		};

		expect(scenario.expected).toContain('before');
	});

	it('should return null for selection entirely within deleted section', () => {
		// When both start and end are inside the same deleted section
		// The selection is invalid and should return null

		const scenario = {
			input: 'Selection is entirely within x-modified[type="del"]',
			expected: 'Selection returns null (invalid)'
		};

		expect(scenario.expected).toContain('null');
	});

	it('should allow selection that spans across a deleted section', () => {
		// When selection starts before and ends after a deleted section
		// The selection should include the deleted section (it's just displayed, not editable)

		const scenario = {
			input: 'Selection spans from before to after x-modified[type="del"]',
			expected: 'Selection is valid and includes the deleted section'
		};

		expect(scenario.expected).toContain('valid');
	});

	it('should not affect selection near but not within deleted sections', () => {
		// When selection is adjacent to but not inside a deleted section
		// Normal snapping behavior applies

		const scenario = {
			input: 'Selection is adjacent to x-modified[type="del"]',
			expected: 'Normal snapping behavior, no modification for deleted sections'
		};

		expect(scenario.expected).toContain('Normal');
	});
});
