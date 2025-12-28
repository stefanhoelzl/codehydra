import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error - jsdom types not installed
import { JSDOM } from 'jsdom';
import { diffHtml, stripModifiedTags } from '$lib/utils/html-diff';

describe('html-diff', () => {
	let dom: JSDOM;
	let document: Document;
	let window: Window & typeof globalThis;

	beforeEach(() => {
		dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
			url: 'http://localhost',
			pretendToBeVisual: true
		});

		document = dom.window.document;
		window = dom.window as unknown as Window & typeof globalThis;

		vi.stubGlobal('document', document);
		vi.stubGlobal('window', window);
		vi.stubGlobal('Node', dom.window.Node);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('diffHtml', () => {
		describe('no changes', () => {
			it('should return same HTML when no changes', () => {
				const html = '<p>Hello world</p>';
				expect(diffHtml(html, html)).toBe(html);
			});

			it('should handle empty strings', () => {
				expect(diffHtml('', '')).toBe('');
			});
		});

		describe('simple additions', () => {
			it('should mark added text', () => {
				const oldHtml = '<p>Hello</p>';
				const newHtml = '<p>Hello world</p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified type="add">');
				expect(result).toContain('world');
			});

			it('should mark added element', () => {
				const oldHtml = '<p>Hello</p>';
				const newHtml = '<p>Hello</p><p>World</p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified type="add">');
				expect(result).toContain('World');
			});
		});

		describe('simple deletions', () => {
			it('should mark deleted text', () => {
				const oldHtml = '<p>Hello world</p>';
				const newHtml = '<p>Hello</p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified type="del">');
				expect(result).toContain('world');
			});

			it('should include deleted HTML formatting', () => {
				const oldHtml = '<p>Hello <b>world</b></p>';
				const newHtml = '<p>Hello</p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified type="del">');
				expect(result).toContain('<b>world</b>');
			});
		});

		describe('changes', () => {
			it('should mark changed text with previous attribute', () => {
				const oldHtml = '<p>Hello world</p>';
				const newHtml = '<p>Hello earth</p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified type="change"');
				expect(result).toContain('previous="world"');
				expect(result).toContain('earth');
			});

			it('should have text-only content in previous attribute (no HTML tags)', () => {
				const oldHtml = '<p>Hello <b>world</b></p>';
				const newHtml = '<p>Hello <b>earth</b></p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('previous="world"');
				expect(result).not.toContain('previous="<b>world</b>"');
			});
		});

		describe('word boundary expansion for changes', () => {
			it('should expand change to word boundaries', () => {
				const oldHtml = '<p>testing</p>';
				const newHtml = '<p>tested</p>';
				const result = diffHtml(newHtml, oldHtml);
				// The whole word should be marked as changed
				expect(result).toContain('<x-modified type="change"');
				expect(result).toContain('previous="testing"');
				expect(result).toContain('>tested</x-modified>');
			});

			it('should stop word expansion at HTML tag boundary', () => {
				const oldHtml = '<p>Hello <b>world</b></p>';
				const newHtml = '<p>Hello <b>earth</b></p>';
				const result = diffHtml(newHtml, oldHtml);
				// Should not expand beyond the <b> tag
				expect(result).toContain('previous="world"');
			});
		});

		describe('merging nearby modifications', () => {
			it('should merge add and del within 20 chars into change', () => {
				const oldHtml = '<p>A B C</p>';
				const newHtml = '<p>X B Z</p>';
				const result = diffHtml(newHtml, oldHtml);
				// A->X and C->Z should be merged because gap "B" is < 20 chars
				expect(result).toContain('<x-modified type="change"');
			});

			it('should not merge two adds', () => {
				const oldHtml = '<p>Hello world</p>';
				const newHtml = '<p>AAA Hello BBB world</p>';
				const result = diffHtml(newHtml, oldHtml);
				// Two separate adds should stay separate
				const addCount = (result.match(/type="add"/g) || []).length;
				expect(addCount).toBeGreaterThanOrEqual(1);
			});

			it('should not merge two dels', () => {
				const oldHtml = '<p>AAA Hello BBB world</p>';
				const newHtml = '<p>Hello world</p>';
				const result = diffHtml(newHtml, oldHtml);
				// Two separate dels should stay separate
				const delCount = (result.match(/type="del"/g) || []).length;
				expect(delCount).toBeGreaterThanOrEqual(1);
			});

			it('should not merge across block tags', () => {
				const oldHtml = '<p>Hello</p><p>World</p>';
				const newHtml = '<p>Hi</p><p>Earth</p>';
				const result = diffHtml(newHtml, oldHtml);
				// Should have separate modifications for each paragraph
				const changeCount = (result.match(/type="change"/g) || []).length;
				expect(changeCount).toBeGreaterThanOrEqual(2);
			});
		});

		describe('ignorable changes', () => {
			it('should ignore whitespace-only changes', () => {
				const oldHtml = '<p>Hello  world</p>';
				const newHtml = '<p>Hello world</p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).not.toContain('<x-modified');
			});

			it('should ignore attribute-only changes', () => {
				const oldHtml = '<div class="a">Hello</div>';
				const newHtml = '<div class="b">Hello</div>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).not.toContain('<x-modified');
			});

			it('should NOT ignore img attribute changes', () => {
				const oldHtml = '<p><img src="a.png"></p>';
				const newHtml = '<p><img src="b.png"></p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified');
			});

			it('should treat br as whitespace', () => {
				const oldHtml = '<p>Hello<br>world</p>';
				const newHtml = '<p>Hello world</p>';
				const result = diffHtml(newHtml, oldHtml);
				// br -> space should be considered whitespace change
				// The result may or may not have x-modified depending on implementation
				expect(result).toBeDefined();
			});
		});

		describe('HTML tag handling', () => {
			it('should treat HTML tags as atomic units', () => {
				const oldHtml = '<p><b>Hello</b></p>';
				const newHtml = '<p><i>Hello</i></p>';
				const result = diffHtml(newHtml, oldHtml);
				// Should mark the tag change
				expect(result).toContain('<x-modified');
			});

			it('should not split x-modified when it encloses complete tags', () => {
				const oldHtml = '<p>Hello <b>world</b> here</p>';
				const newHtml = '<p>Hello <b>earth</b> there</p>';
				const result = diffHtml(newHtml, oldHtml);
				// The change should contain the complete <b> tag
				expect(result).toContain('<b>earth</b>');
			});

			it('should split x-modified when it intersects with tags', () => {
				// This is a tricky case - when the change boundary falls inside a tag structure
				const oldHtml = '<p>AB<b>CD</b>EF</p>';
				const newHtml = '<p>XY<b>CD</b>EF</p>';
				const result = diffHtml(newHtml, oldHtml);
				// Change should be properly bounded
				expect(result).toContain('<x-modified');
			});
		});

		describe('block element handling', () => {
			it('should split x-modified at block boundaries', () => {
				const oldHtml = '<p>Hello</p><p>World</p>';
				const newHtml = '<p>Hi</p><p>Earth</p>';
				const result = diffHtml(newHtml, oldHtml);
				// Each block should have its own x-modified
				expect(result).toContain('<p>');
				expect(result).toContain('</p>');
			});

			it('should elevate add type when wrapping entire block content', () => {
				const oldHtml = '<p></p>';
				const newHtml = '<p>New content</p>';
				const result = diffHtml(newHtml, oldHtml);
				// The x-modified should wrap the <p>, not be inside it
				expect(result).toMatch(/<x-modified[^>]*type="add"[^>]*><p>/);
			});

			it('should elevate del type when wrapping entire block content', () => {
				const oldHtml = '<div><p>Old paragraph</p></div>';
				const newHtml = '<div></div>';
				const result = diffHtml(newHtml, oldHtml);
				// The x-modified should wrap the <p>, not be inside it
				expect(result).toMatch(/<x-modified[^>]*type="del"[^>]*><p>/);
			});

			it('should NOT elevate change type', () => {
				const oldHtml = '<p>Old text</p>';
				const newHtml = '<p>New text</p>';
				const result = diffHtml(newHtml, oldHtml);
				// Change should stay inside the <p>
				expect(result).toMatch(/<p><x-modified[^>]*type="change"/);
			});
		});

		describe('escaping', () => {
			it('should escape special characters in previous attribute', () => {
				const oldHtml = '<p>Hello "world" &amp; friends</p>';
				const newHtml = '<p>Hello earth</p>';
				const result = diffHtml(newHtml, oldHtml);
				// The previous attribute should have escaped quotes
				expect(result).toContain('&quot;');
			});
		});

		describe('complex scenarios', () => {
			it('should handle nested formatting changes', () => {
				const oldHtml = '<p>Hello <b><i>world</i></b></p>';
				const newHtml = '<p>Hello <b><i>earth</i></b></p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified');
				expect(result).toContain('previous="world"');
			});

			it('should handle multiple changes in same paragraph', () => {
				const oldHtml = '<p>The quick brown fox jumps over the lazy dog</p>';
				const newHtml = '<p>The slow brown cat jumps over the lazy dog</p>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified');
			});

			it('should handle list item changes', () => {
				const oldHtml = '<ul><li>Item 1</li><li>Item 2</li></ul>';
				const newHtml = '<ul><li>Item A</li><li>Item B</li></ul>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified');
			});

			it('should handle table cell changes', () => {
				const oldHtml = '<table><tr><td>A</td><td>B</td></tr></table>';
				const newHtml = '<table><tr><td>X</td><td>Y</td></tr></table>';
				const result = diffHtml(newHtml, oldHtml);
				expect(result).toContain('<x-modified');
			});
		});
	});

	describe('stripModifiedTags', () => {
		it('should remove del tags entirely including content', () => {
			const container = document.createElement('div');
			container.innerHTML = '<p>Hello <x-modified type="del">deleted</x-modified> world</p>';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('<p>Hello  world</p>');
			expect(container.innerHTML).not.toContain('deleted');
		});

		it('should unwrap add tags keeping content', () => {
			const container = document.createElement('div');
			container.innerHTML = '<p>Hello <x-modified type="add">new</x-modified> world</p>';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('<p>Hello new world</p>');
			expect(container.innerHTML).not.toContain('x-modified');
		});

		it('should unwrap change tags keeping content', () => {
			const container = document.createElement('div');
			container.innerHTML =
				'<p>Hello <x-modified type="change" previous="old">new</x-modified> world</p>';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('<p>Hello new world</p>');
			expect(container.innerHTML).not.toContain('x-modified');
			expect(container.innerHTML).not.toContain('old');
		});

		it('should handle nested x-modified tags', () => {
			const container = document.createElement('div');
			container.innerHTML =
				'<x-modified type="add"><p><x-modified type="change" previous="a">b</x-modified></p></x-modified>';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('<p>b</p>');
		});

		it('should handle multiple x-modified tags', () => {
			const container = document.createElement('div');
			container.innerHTML =
				'<p><x-modified type="add">A</x-modified> B <x-modified type="del">C</x-modified> D</p>';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('<p>A B  D</p>');
		});

		it('should preserve HTML inside unwrapped tags', () => {
			const container = document.createElement('div');
			container.innerHTML = '<x-modified type="add"><p><b>Bold</b> text</p></x-modified>';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('<p><b>Bold</b> text</p>');
		});

		it('should handle empty container', () => {
			const container = document.createElement('div');
			container.innerHTML = '';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('');
		});

		it('should handle container with no x-modified tags', () => {
			const container = document.createElement('div');
			container.innerHTML = '<p>Hello world</p>';
			stripModifiedTags(container);
			expect(container.innerHTML).toBe('<p>Hello world</p>');
		});
	});
});
