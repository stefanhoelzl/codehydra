import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processAnswers } from '$lib/utils/answer-processing';

describe('answer-processing', () => {
	// Suppress console.warn logs during tests (edge case warnings are expected behavior)
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('processAnswers', () => {
		it('should extract a single answer with messages', () => {
			const response = `
<answer href="a-1">
<msg author="User">Original question</msg>
<msg author="AI">This is the answer</msg>
</answer>
<document>Some content</document>
`;

			const result = processAnswers(response);

			expect(result.answers.length).toBe(1);
			expect(result.answers[0].id).toBe('a-1');
			expect(result.answers[0].messages.length).toBe(2);
			expect(result.answers[0].messages[0].author).toBe('User');
			expect(result.answers[0].messages[0].content).toBe('Original question');
			expect(result.answers[0].messages[1].author).toBe('AI');
			expect(result.answers[0].messages[1].content).toBe('This is the answer');
		});

		it('should extract multiple answers', () => {
			const response = `
<answer href="a-1">
<msg author="User">Question 1</msg>
<msg author="AI">First answer</msg>
</answer>
<answer href="a-2">
<msg author="User">Question 2</msg>
<msg author="AI">Second answer</msg>
</answer>
<answer href="a-3">
<msg author="User">Question 3</msg>
<msg author="AI">Third answer</msg>
</answer>
<document>Content here</document>
`;

			const result = processAnswers(response);

			expect(result.answers.length).toBe(3);
			expect(result.answers.find((a) => a.id === 'a-1')?.messages[1].content).toBe('First answer');
			expect(result.answers.find((a) => a.id === 'a-2')?.messages[1].content).toBe('Second answer');
			expect(result.answers.find((a) => a.id === 'a-3')?.messages[1].content).toBe('Third answer');
		});

		it('should extract document content and exclude answer tags', () => {
			const response = `
<answer href="a-1">
<msg author="User">Question</msg>
<msg author="AI">Remove this</msg>
</answer>
<document>Keep this content</document>
`;

			const result = processAnswers(response);

			expect(result.cleanedMarkdown).not.toContain('<answer');
			expect(result.cleanedMarkdown).not.toContain('</answer>');
			expect(result.cleanedMarkdown).not.toContain('<document>');
			expect(result.cleanedMarkdown).toBe('Keep this content');
		});

		it('should handle answers with multiline content', () => {
			const response = `
<answer href="a-1">
<msg author="User">Question</msg>
<msg author="AI">First line
Second line
Third line</msg>
</answer>
`;

			const result = processAnswers(response);

			const answer = result.answers.find((a) => a.id === 'a-1');
			expect(answer?.messages[1].content).toContain('First line');
			expect(answer?.messages[1].content).toContain('Second line');
			expect(answer?.messages[1].content).toContain('Third line');
		});

		it('should handle answers with special characters', () => {
			const response = `
<answer href="a-1">
<msg author="User">Question</msg>
<msg author="AI">Answer with "quotes" and 'apostrophes'</msg>
</answer>
`;

			const result = processAnswers(response);

			const answer = result.answers.find((a) => a.id === 'a-1');
			expect(answer?.messages[1].content).toContain('"quotes"');
			expect(answer?.messages[1].content).toContain("'apostrophes'");
		});

		it('should skip answers with no messages', () => {
			const response = `
<answer href="a-1"></answer>
<answer href="a-2">
<msg author="User">Question</msg>
<msg author="AI">Real answer</msg>
</answer>
`;

			const result = processAnswers(response);

			expect(result.answers.find((a) => a.id === 'a-1')).toBeUndefined();
			expect(result.answers.find((a) => a.id === 'a-2')).toBeDefined();
			expect(result.answers.length).toBe(1);
		});

		it('should handle duplicate answer IDs (keep last)', () => {
			const response = `
<answer href="a-1">
<msg author="User">Question 1</msg>
<msg author="AI">First answer for a-1</msg>
</answer>
<answer href="a-1">
<msg author="User">Question 2</msg>
<msg author="AI">Second answer for a-1</msg>
</answer>
`;

			const result = processAnswers(response);

			expect(result.answers.length).toBe(1);
			expect(result.answers[0].messages[1].content).toBe('Second answer for a-1');
		});

		it('should handle missing href attribute gracefully', () => {
			const response = `
<answer>
<msg author="User">No href here</msg>
</answer>
<answer href="a-1">
<msg author="User">Question</msg>
<msg author="AI">Valid answer</msg>
</answer>
`;

			const result = processAnswers(response);

			// The malformed tag without href won't match the regex, so it won't be extracted
			expect(result.answers.find((a) => a.id === 'a-1')).toBeDefined();
			expect(result.answers.length).toBe(1);
		});

		it('should handle answers with markdown formatting', () => {
			const response = `
<answer href="a-1">
<msg author="User">Question</msg>
<msg author="AI">**Bold text** and *italic* and \`code\`</msg>
</answer>
`;

			const result = processAnswers(response);

			const answer = result.answers.find((a) => a.id === 'a-1');
			expect(answer?.messages[1].content).toContain('**Bold text**');
			expect(answer?.messages[1].content).toContain('*italic*');
			expect(answer?.messages[1].content).toContain('`code`');
		});

		it('should preserve document content when extracting', () => {
			const response = `
<answer href="a-1">
<msg author="User">Question</msg>
<msg author="AI">Answer to question</msg>
</answer>
<document># Title

Some paragraph text.

<x-annotation id="a-1">highlighted text</x-annotation>

More content after annotation.</document>
`;

			const result = processAnswers(response);

			expect(result.cleanedMarkdown).toContain('# Title');
			expect(result.cleanedMarkdown).toContain('Some paragraph text.');
			expect(result.cleanedMarkdown).toContain('highlighted text');
			expect(result.cleanedMarkdown).toContain('More content after annotation.');
			expect(result.cleanedMarkdown).not.toContain('<answer');
		});

		it('should handle no answers', () => {
			const response = `<document>Just a document with no answers</document>`;

			const result = processAnswers(response);

			expect(result.answers.length).toBe(0);
			expect(result.cleanedMarkdown).toBe('Just a document with no answers');
		});

		it('should fallback to full response if no document tag', () => {
			const response = `Just raw content without document tags`;

			const result = processAnswers(response);

			expect(result.answers.length).toBe(0);
			expect(result.cleanedMarkdown).toBe('Just raw content without document tags');
		});

		it('should preserve full conversation history in answer', () => {
			const response = `
<answer href="a-1">
<msg author="User">First question</msg>
<msg author="AI">First response</msg>
<msg author="User">Follow-up question</msg>
<msg author="AI">Follow-up response</msg>
</answer>
<document>Content</document>
`;

			const result = processAnswers(response);

			expect(result.answers.length).toBe(1);
			expect(result.answers[0].messages.length).toBe(4);
			expect(result.answers[0].messages[0].author).toBe('User');
			expect(result.answers[0].messages[0].content).toBe('First question');
			expect(result.answers[0].messages[1].author).toBe('AI');
			expect(result.answers[0].messages[1].content).toBe('First response');
			expect(result.answers[0].messages[2].author).toBe('User');
			expect(result.answers[0].messages[2].content).toBe('Follow-up question');
			expect(result.answers[0].messages[3].author).toBe('AI');
			expect(result.answers[0].messages[3].content).toBe('Follow-up response');
		});
	});
});
