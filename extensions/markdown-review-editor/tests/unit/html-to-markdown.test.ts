import { describe, it, expect } from 'vitest';
import { annotated_md2html, annotated_html2md } from '$lib/utils/html-to-markdown';

describe('html-to-markdown', () => {
	describe('annotated_md2html - x-by conversion', () => {
		it('should convert markdown bold to HTML strong in x-by content', () => {
			const markdown = `<x-annotation id="a-1">text<x-comment><x-by author="AI">This is **bold** text</x-by></x-comment></x-annotation>`;

			const result = annotated_md2html(markdown);

			expect(result).toContain('<x-by author="AI">');
			expect(result).toContain('<strong>bold</strong>');
		});

		it('should convert markdown italic to HTML em in x-by content', () => {
			const markdown = `<x-annotation id="a-1">text<x-comment><x-by author="AI">This is _italic_ text</x-by></x-comment></x-annotation>`;

			const result = annotated_md2html(markdown);

			expect(result).toContain('<x-by author="AI">');
			expect(result).toContain('<em>italic</em>');
		});

		it('should convert markdown code to HTML code in x-by content', () => {
			const markdown = `<x-annotation id="a-1">text<x-comment><x-by author="AI">Use the \`console.log\` function</x-by></x-comment></x-annotation>`;

			const result = annotated_md2html(markdown);

			expect(result).toContain('<x-by author="AI">');
			expect(result).toContain('<code>console.log</code>');
		});

		it('should convert markdown lists to HTML in x-by content', () => {
			const markdown = `<x-annotation id="a-1">text<x-comment><x-by author="AI">Here are the options:
- Option 1
- Option 2
- Option 3</x-by></x-comment></x-annotation>`;

			const result = annotated_md2html(markdown);

			expect(result).toContain('<x-by author="AI">');
			expect(result).toContain('<ul>');
			expect(result).toContain('<li>Option 1</li>');
			expect(result).toContain('<li>Option 2</li>');
			expect(result).toContain('<li>Option 3</li>');
		});

		it('should convert multiple x-by elements with markdown', () => {
			const markdown = `<x-annotation id="a-1">text<x-comment><x-by author="User">Why is **this** important?</x-by><x-by author="AI">Because _reasons_</x-by></x-comment></x-annotation>`;

			const result = annotated_md2html(markdown);

			expect(result).toContain('<x-by author="User">');
			expect(result).toContain('<strong>this</strong>');
			expect(result).toContain('<x-by author="AI">');
			expect(result).toContain('<em>reasons</em>');
		});

		it('should preserve x-by elements without markdown', () => {
			const markdown = `<x-annotation id="a-1">text<x-comment><x-by author="User">Plain text</x-by></x-comment></x-annotation>`;

			const result = annotated_md2html(markdown);

			expect(result).toContain('<x-by author="User">');
			expect(result).toContain('Plain text');
		});

		it('should still convert main annotation content', () => {
			const markdown = `<x-annotation id="a-1">**bold** content<x-comment><x-by author="AI">answer</x-by></x-comment></x-annotation>`;

			const result = annotated_md2html(markdown);

			expect(result).toContain('<strong>bold</strong> content');
		});
	});

	describe('annotated_html2md - x-by conversion', () => {
		it('should convert HTML strong to markdown bold in x-by content', () => {
			const html = `<x-annotation id="a-1">text<x-comment><x-by author="AI">This is <strong>bold</strong> text</x-by></x-comment></x-annotation>`;

			const result = annotated_html2md(html);

			expect(result).toContain('<x-by author="AI">This is **bold** text</x-by>');
		});

		it('should convert HTML em to markdown italic in x-by content', () => {
			const html = `<x-annotation id="a-1">text<x-comment><x-by author="AI">This is <em>italic</em> text</x-by></x-comment></x-annotation>`;

			const result = annotated_html2md(html);

			expect(result).toContain('<x-by author="AI">This is _italic_ text</x-by>');
		});

		it('should convert HTML code to markdown backticks in x-by content', () => {
			const html = `<x-annotation id="a-1">text<x-comment><x-by author="AI">Use the <code>console.log</code> function</x-by></x-comment></x-annotation>`;

			const result = annotated_html2md(html);

			expect(result).toContain('<x-by author="AI">Use the `console.log` function</x-by>');
		});

		it('should convert HTML lists to markdown in x-by content', () => {
			const html = `<x-annotation id="a-1">text<x-comment><x-by author="AI"><p>Options:</p><ul><li>Option 1</li><li>Option 2</li></ul></x-by></x-comment></x-annotation>`;

			const result = annotated_html2md(html);

			expect(result).toContain('<x-by author="AI">');
			expect(result).toContain('Option 1');
			expect(result).toContain('Option 2');
		});

		it('should convert multiple x-by elements with HTML', () => {
			const html = `<x-annotation id="a-1">text<x-comment><x-by author="User">Why is <strong>this</strong> important?</x-by><x-by author="AI">Because <em>reasons</em></x-by></x-comment></x-annotation>`;

			const result = annotated_html2md(html);

			expect(result).toContain('<x-by author="User">Why is **this** important?</x-by>');
			expect(result).toContain('<x-by author="AI">Because _reasons_</x-by>');
		});

		it('should preserve x-by elements without HTML', () => {
			const html = `<x-annotation id="a-1">text<x-comment><x-by author="User">Plain text</x-by></x-comment></x-annotation>`;

			const result = annotated_html2md(html);

			expect(result).toContain('<x-by author="User">Plain text</x-by>');
		});

		it('should still convert main annotation content', () => {
			const html = `<x-annotation id="a-1"><strong>bold</strong> content<x-comment><x-by author="AI">answer</x-by></x-comment></x-annotation>`;

			const result = annotated_html2md(html);

			expect(result).toContain('**bold** content');
		});
	});

	describe('round-trip conversion', () => {
		it('should preserve content through md2html and html2md cycle', () => {
			const originalMd = `<x-annotation id="a-1">some text<x-comment><x-by author="User">Question about **bold**?</x-by><x-by author="AI">Use _italic_ for emphasis</x-by></x-comment></x-annotation>`;

			const html = annotated_md2html(originalMd);
			const backToMd = annotated_html2md(html);

			// Content should be preserved (though formatting might differ slightly)
			expect(backToMd).toContain('Question about **bold**?');
			expect(backToMd).toContain('Use _italic_ for emphasis');
			expect(backToMd).toContain('<x-by author="User">');
			expect(backToMd).toContain('<x-by author="AI">');
		});
	});
});
