import { describe, it, expect } from 'vitest';
import { serializeDocument, deserializeDocument } from '$lib/utils/document-storage';

describe('document-storage', () => {
	describe('serializeDocument', () => {
		it('should create two sections separated by ----', () => {
			const documentHtml = '<p>Hello <x-annotation id="a-1">world</x-annotation></p>';
			const annotations = [{ id: 'a-1', messages: [{ author: 'User', content: 'Test message' }] }];

			const result = serializeDocument(documentHtml, annotations);

			expect(result).toContain('<discussion href="a-1">');
			expect(result).toContain('----');
			expect(result).toContain('<x-annotation id="a-1">world</x-annotation>');
		});

		it('should serialize discussions with msg elements', () => {
			const documentHtml = '<p>Text</p>';
			const annotations = [
				{
					id: 'a-1',
					messages: [
						{ author: 'User', content: 'Question?' },
						{ author: 'AI', content: 'Answer.' }
					]
				}
			];

			const result = serializeDocument(documentHtml, annotations);

			expect(result).toContain('<discussion href="a-1">');
			expect(result).toContain('<msg author="User">Question?</msg>');
			expect(result).toContain('<msg author="AI">Answer.</msg>');
		});

		it('should handle multiple discussions', () => {
			const documentHtml =
				'<p><x-annotation id="a-1">One</x-annotation> and <x-annotation id="a-2">Two</x-annotation></p>';
			const annotations = [
				{ id: 'a-1', messages: [{ author: 'User', content: 'Comment 1' }] },
				{ id: 'a-2', messages: [{ author: 'User', content: 'Comment 2' }] }
			];

			const result = serializeDocument(documentHtml, annotations);

			expect(result).toContain('<discussion href="a-1">');
			expect(result).toContain('<discussion href="a-2">');
			expect(result).toContain('<msg author="User">Comment 1</msg>');
			expect(result).toContain('<msg author="User">Comment 2</msg>');
		});

		it('should handle empty annotations list', () => {
			const documentHtml = '<h1>Title</h1><p>Content</p>';
			const annotations: { id: string; messages: { author: string; content: string }[] }[] = [];

			const result = serializeDocument(documentHtml, annotations);

			expect(result).not.toContain('<discussion');
			expect(result).not.toContain('----');
			expect(result).toContain('# Title');
			expect(result).toContain('Content');
		});

		it('should filter out annotations with no messages', () => {
			const documentHtml = '<p>Text</p>';
			const annotations = [
				{ id: 'a-1', messages: [] },
				{ id: 'a-2', messages: [{ author: 'User', content: 'Has message' }] }
			];

			const result = serializeDocument(documentHtml, annotations);

			expect(result).not.toContain('<discussion href="a-1">');
			expect(result).toContain('<discussion href="a-2">');
		});
	});

	describe('deserializeDocument', () => {
		it('should parse discussions section correctly', () => {
			const markdown = `<discussion href="a-1">
  <msg author="User">Question here</msg>
  <msg author="AI">Answer here</msg>
</discussion>

----

# Title

Hello world`;

			const result = deserializeDocument(markdown);

			expect(result.annotations.length).toBe(1);
			expect(result.annotations[0].id).toBe('a-1');
			expect(result.annotations[0].messages.length).toBe(2);
			expect(result.annotations[0].messages[0].author).toBe('User');
			expect(result.annotations[0].messages[0].content).toBe('Question here');
			expect(result.annotations[0].messages[1].author).toBe('AI');
			expect(result.annotations[0].messages[1].content).toBe('Answer here');
		});

		it('should parse document section correctly', () => {
			const markdown = `<discussion href="a-1">
  <msg author="User">Test</msg>
</discussion>

----

# Title

This is <x-annotation id="a-1">annotated</x-annotation> text.`;

			const result = deserializeDocument(markdown);

			expect(result.documentHtml).toContain('<h1>Title</h1>');
			expect(result.documentHtml).toContain('<x-annotation id="a-1">annotated</x-annotation>');
		});

		it('should handle multiple discussions', () => {
			const markdown = `<discussion href="a-1">
  <msg author="User">First</msg>
</discussion>

<discussion href="a-2">
  <msg author="User">Second</msg>
  <msg author="AI">Reply</msg>
</discussion>

----

# Doc`;

			const result = deserializeDocument(markdown);

			expect(result.annotations.length).toBe(2);
			expect(result.annotations[0].id).toBe('a-1');
			expect(result.annotations[1].id).toBe('a-2');
			expect(result.annotations[1].messages.length).toBe(2);
		});

		it('should handle documents without discussions', () => {
			const markdown = `# Just a Title

Some plain content here.`;

			const result = deserializeDocument(markdown);

			expect(result.annotations.length).toBe(0);
			expect(result.documentHtml).toContain('<h1>Just a Title</h1>');
			expect(result.documentHtml).toContain('Some plain content here.');
		});

		it('should handle ---- in document content when no discussions', () => {
			const markdown = `# Title

Some text

----

More text after horizontal rule`;

			const result = deserializeDocument(markdown);

			// Since there's no <discussion> before ----, treat the whole thing as document
			expect(result.annotations.length).toBe(0);
			expect(result.documentHtml).toContain('Title');
		});
	});

	describe('round-trip', () => {
		it('should preserve content through serialize/deserialize cycle', () => {
			const originalHtml = '<h1>Title</h1><p>Hello <x-annotation id="a-1">world</x-annotation></p>';
			const originalAnnotations = [
				{
					id: 'a-1',
					messages: [
						{ author: 'User', content: 'What about this?' },
						{ author: 'AI', content: 'It looks good.' }
					]
				}
			];

			const serialized = serializeDocument(originalHtml, originalAnnotations);
			const deserialized = deserializeDocument(serialized);

			expect(deserialized.annotations.length).toBe(1);
			expect(deserialized.annotations[0].id).toBe('a-1');
			expect(deserialized.annotations[0].messages.length).toBe(2);
			expect(deserialized.annotations[0].messages[0].content).toBe('What about this?');
			expect(deserialized.annotations[0].messages[1].content).toBe('It looks good.');
		});

		it('should preserve annotation IDs', () => {
			const html = '<p><x-annotation id="test-123">text</x-annotation></p>';
			const annotations = [{ id: 'test-123', messages: [{ author: 'User', content: 'note' }] }];

			const serialized = serializeDocument(html, annotations);
			const deserialized = deserializeDocument(serialized);

			expect(deserialized.documentHtml).toContain('id="test-123"');
			expect(deserialized.annotations[0].id).toBe('test-123');
		});

		it('should preserve message authors and content', () => {
			const html = '<p>text</p>';
			const annotations = [
				{
					id: 'a-1',
					messages: [
						{ author: 'User', content: 'First question' },
						{ author: 'AI', content: 'First answer' },
						{ author: 'User', content: 'Follow-up' },
						{ author: 'AI', content: 'More info' }
					]
				}
			];

			const serialized = serializeDocument(html, annotations);
			const deserialized = deserializeDocument(serialized);

			expect(deserialized.annotations[0].messages.length).toBe(4);
			expect(deserialized.annotations[0].messages[0]).toEqual({
				author: 'User',
				content: 'First question'
			});
			expect(deserialized.annotations[0].messages[3]).toEqual({
				author: 'AI',
				content: 'More info'
			});
		});
	});

	describe('edge cases', () => {
		it('should handle special characters in messages', () => {
			const html = '<p>text</p>';
			const annotations = [
				{
					id: 'a-1',
					messages: [{ author: 'User', content: 'What about <code> and "quotes"?' }]
				}
			];

			const serialized = serializeDocument(html, annotations);
			const deserialized = deserializeDocument(serialized);

			expect(deserialized.annotations[0].messages[0].content).toContain('<code>');
			expect(deserialized.annotations[0].messages[0].content).toContain('"quotes"');
		});

		it('should handle markdown formatting in messages', () => {
			const html = '<p>text</p>';
			const annotations = [
				{
					id: 'a-1',
					messages: [{ author: 'User', content: 'Use **bold** and _italic_' }]
				}
			];

			const serialized = serializeDocument(html, annotations);
			const deserialized = deserializeDocument(serialized);

			expect(deserialized.annotations[0].messages[0].content).toContain('**bold**');
			expect(deserialized.annotations[0].messages[0].content).toContain('_italic_');
		});

		it('should handle empty document with annotations', () => {
			const html = '';
			const annotations = [{ id: 'a-1', messages: [{ author: 'User', content: 'note' }] }];

			const serialized = serializeDocument(html, annotations);
			const deserialized = deserializeDocument(serialized);

			expect(deserialized.annotations.length).toBe(1);
		});
	});
});
