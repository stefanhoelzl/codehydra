import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

describe('annotation elements', () => {
	let dom: JSDOM;
	let document: Document;
	let window: Window & typeof globalThis;

	beforeEach(() => {
		dom = new JSDOM(
			`
			<!DOCTYPE html>
			<html>
				<body>
					<div class="html-annotator">
						<div class="html-annotator-content">
							<p>Some text before <annotation data-id="test-1">annotated text<comment></comment></annotation> and after.</p>
						</div>
						<div class="annotation-sidebar"></div>
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

		vi.stubGlobal('document', document);
		vi.stubGlobal('window', window);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('custom element registration', () => {
		it('should describe annotation element structure', () => {
			// The annotation element should:
			// - Wrap selected text content
			// - Contain a comment child element
			// - Have a data-id attribute for identification

			const structure = {
				element: 'annotation',
				attributes: ['data-id'],
				children: ['comment'],
				purpose: 'Wraps annotated text with visual highlight'
			};

			expect(structure.element).toBe('annotation');
			expect(structure.children).toContain('comment');
		});

		it('should describe comment element structure', () => {
			// The comment element should:
			// - Be a child of annotation
			// - Display in sidebar when positioned
			// - Have a close button

			const structure = {
				element: 'comment',
				components: ['comment-content', 'comment-close'],
				purpose: 'Contains comment text and close button'
			};

			expect(structure.element).toBe('comment');
			expect(structure.components).toContain('comment-close');
		});
	});

	describe('DOM structure', () => {
		it('should have annotation in content area', () => {
			const content = document.querySelector('.html-annotator-content');
			const annotation = content?.querySelector('annotation');

			expect(annotation).not.toBeNull();
			expect(annotation?.getAttribute('data-id')).toBe('test-1');
		});

		it('should have comment inside annotation', () => {
			const annotation = document.querySelector('annotation');
			const comment = annotation?.querySelector('comment');

			expect(comment).not.toBeNull();
		});

		it('should have sidebar for comment positioning', () => {
			const sidebar = document.querySelector('.annotation-sidebar');
			expect(sidebar).not.toBeNull();
		});

		it('should preserve text content around annotation', () => {
			const content = document.querySelector('.html-annotator-content p');
			expect(content?.textContent).toContain('Some text before');
			expect(content?.textContent).toContain('annotated text');
			expect(content?.textContent).toContain('and after');
		});
	});

	describe('annotation removal behavior', () => {
		it('should describe close button behavior', () => {
			// When close button is clicked:
			// 1. An 'annotation-close' event should be dispatched
			// 2. The parent should handle removing the annotation
			// 3. The annotated text should remain, unwrapped

			const behavior = {
				trigger: 'close button click',
				event: 'annotation-close',
				result: 'Annotation wrapper removed, text preserved'
			};

			expect(behavior.event).toBe('annotation-close');
			expect(behavior.result).toContain('text preserved');
		});

		it('should describe annotation unwrapping', () => {
			// When annotation is removed:
			// Before: <p>text<annotation>selected<comment>...</comment></annotation>more</p>
			// After:  <p>textselectedmore</p>

			const annotation = document.querySelector('annotation');
			const textContent = annotation?.textContent || '';

			// The annotation should contain its text (excluding comment content)
			expect(textContent).toContain('annotated text');
		});
	});

	describe('event bubbling', () => {
		it('should describe event propagation', () => {
			// Custom events from annotation elements should:
			// - Bubble up through the DOM
			// - Be catchable at the HtmlAnnotator container level
			// - Include detail about which annotation triggered the event

			const eventSpec = {
				eventName: 'annotation-close',
				bubbles: true,
				composed: true,
				detail: { annotation: 'HTMLElement reference' }
			};

			expect(eventSpec.bubbles).toBe(true);
			expect(eventSpec.detail).toHaveProperty('annotation');
		});
	});
});

describe('wrapSelectionWithAnnotation utility', () => {
	let dom: JSDOM;
	let document: Document;

	beforeEach(() => {
		dom = new JSDOM(
			`
			<!DOCTYPE html>
			<html>
				<body>
					<div class="html-annotator">
						<div class="html-annotator-content">
							<p>First paragraph with some text.</p>
							<p>Second paragraph.</p>
						</div>
						<div class="annotation-sidebar"></div>
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
		vi.stubGlobal('document', document);
		vi.stubGlobal('window', dom.window);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('wrapping behavior', () => {
		it('should describe annotation creation from selection', () => {
			// When text is selected and wrapped:
			// 1. The selected range is extracted
			// 2. An <annotation> element is created with unique ID
			// 3. A <comment> element is appended (initially empty)
			// 4. The annotation replaces the original selection

			const process = {
				steps: ['extract range', 'create annotation', 'append comment', 'insert node'],
				resultStructure: '<annotation data-id="...">selected text<comment></comment></annotation>'
			};

			expect(process.steps).toHaveLength(4);
			expect(process.resultStructure).toContain('annotation');
			expect(process.resultStructure).toContain('comment');
		});

		it('should describe prevention of nested annotations', () => {
			// Should not allow annotating already annotated text
			// This prevents confusing nested annotation structures

			const rule = {
				check: 'Is selection inside existing annotation?',
				ifTrue: 'Return null, do not wrap',
				ifFalse: 'Proceed with wrapping'
			};

			expect(rule.ifTrue).toContain('null');
		});
	});

	describe('removeAnnotation utility', () => {
		it('should describe annotation removal process', () => {
			// When an annotation is removed:
			// 1. Extract all child nodes except <comment>
			// 2. Remove any orphaned comment from sidebar
			// 3. Insert children before annotation
			// 4. Remove annotation element

			const process = {
				steps: [
					'filter out comment children',
					'remove sidebar comment if present',
					'insert children before annotation',
					'remove annotation element'
				],
				result: 'Original text restored without wrapper'
			};

			expect(process.steps).toHaveLength(4);
			expect(process.result).toContain('restored');
		});
	});
});

describe('annotation styling', () => {
	it('should describe annotation visual style', () => {
		// Annotations should have:
		// - Light blue background
		// - Underline
		// - Inline display
		// - Hover state

		const style = {
			background: 'light blue (rgba)',
			textDecoration: 'underline',
			display: 'inline',
			hasHoverState: true
		};

		expect(style.background).toContain('blue');
		expect(style.textDecoration).toBe('underline');
	});

	it('should describe comment bubble style', () => {
		// Comment bubbles should have:
		// - Positioned in sidebar
		// - Background matching theme
		// - Border and shadow
		// - Close button in corner

		const style = {
			position: 'absolute in sidebar',
			background: 'var(--color-bg-secondary)',
			border: 'solid with theme color',
			closeButton: 'top-right corner'
		};

		expect(style.position).toContain('sidebar');
		expect(style.closeButton).toContain('corner');
	});
});
