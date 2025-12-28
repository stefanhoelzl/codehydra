/**
 * Answer processing utilities for OpenCode annotation processing.
 * Extracts <answer> tags from AI responses and prepares them for annotation updates.
 */

import type { Message, AnnotationContent } from './annotation-types';

export interface ProcessAnswersResult {
	/** The markdown document with <answer> tags removed */
	cleanedMarkdown: string;
	/** Array of annotation contents with full message history */
	answers: AnnotationContent[];
}

/**
 * Parse <msg> elements from answer content.
 * Each <msg author="...">content</msg> becomes a Message.
 */
function parseMessages(content: string): Message[] {
	const messages: Message[] = [];
	const msgRegex = /<msg\s+author="([^"]+)"\s*>([\s\S]*?)<\/msg>/g;

	let match;
	while ((match = msgRegex.exec(content)) !== null) {
		messages.push({
			author: match[1],
			content: match[2].trim()
		});
	}

	return messages;
}

/**
 * Extract <answer> tags and document content from AI response.
 * The response format is: <answer> tags followed by <document>content</document>
 *
 * Each answer contains the full message history:
 * <answer href="a-1">
 *   <msg author="User">original comment</msg>
 *   <msg author="AI">response</msg>
 *   ...
 * </answer>
 *
 * @param response - The full response from AI (<answer> tags + document tag)
 * @returns Object with document markdown and answers array
 */
export function processAnswers(response: string): ProcessAnswersResult {
	const answers: AnnotationContent[] = [];
	const seenIds = new Set<string>();

	// Regex to match <answer> tags with href attribute
	// Captures: 1) annotation ID from href, 2) answer content (contains <msg> elements)
	const answerRegex = /<answer\s+href="([^"]+)"\s*>([\s\S]*?)<\/answer>/g;

	let match;
	while ((match = answerRegex.exec(response)) !== null) {
		const annotationId = match[1];
		const answerContent = match[2].trim();

		// Parse messages from answer content
		const messages = parseMessages(answerContent);

		// Skip empty answers (no messages)
		if (messages.length === 0) {
			console.warn(`[answer-processing] Empty answer for annotation "${annotationId}", skipping`);
			continue;
		}

		// Warn on duplicate answers (keep the last one)
		if (seenIds.has(annotationId)) {
			console.warn(
				`[answer-processing] Duplicate answer for annotation "${annotationId}", using last one`
			);
			// Remove the previous entry
			const index = answers.findIndex((a) => a.id === annotationId);
			if (index !== -1) {
				answers.splice(index, 1);
			}
		}

		seenIds.add(annotationId);
		answers.push({
			id: annotationId,
			messages
		});
	}

	// Extract content from <document> tag
	const documentRegex = /<document>([\s\S]*?)<\/document>/;
	const documentMatch = response.match(documentRegex);
	const cleanedMarkdown = documentMatch ? documentMatch[1].trim() : response.trim();

	return { cleanedMarkdown, answers };
}
