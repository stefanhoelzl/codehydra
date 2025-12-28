/**
 * Prompt formatting utilities for OpenCode annotation processing.
 * Formats AnnotationContent objects into <prompt> elements with <msg> tags.
 */

import type { AnnotationContent, Message } from './annotation-types';

/**
 * Formats a single message into a <msg> element.
 */
function formatMessage(msg: Message): string {
	return `<msg author="${msg.author}">${msg.content}</msg>`;
}

/**
 * Formats a single annotation into a <prompt> element.
 * All messages are wrapped in <msg> tags, including the last User message.
 *
 * @param annotation - The annotation content to format
 * @returns Formatted <prompt> element string
 */
export function formatPrompt(annotation: AnnotationContent): string {
	if (annotation.messages.length === 0) {
		return `<prompt href="${annotation.id}"></prompt>`;
	}

	const messageElements = annotation.messages.map(formatMessage).join('\n');
	return `<prompt href="${annotation.id}">\n${messageElements}\n</prompt>`;
}

/**
 * Formats all annotations into a <prompts> list for the OpenCode prompt.
 *
 * @param annotations - Array of annotation contents
 * @returns Formatted <prompts> element string
 */
export function formatAllPrompts(annotations: AnnotationContent[]): string {
	// Only include annotations where the last message is from User with non-empty content
	// This excludes: empty annotations, discussion-only (last msg from AI), and empty user input
	const nonEmpty = annotations.filter((a) => {
		if (a.messages.length === 0) return false;
		const lastMessage = a.messages[a.messages.length - 1];
		return lastMessage.author === 'User' && lastMessage.content.trim() !== '';
	});

	if (nonEmpty.length === 0) {
		return '<prompts>\n(no comments)\n</prompts>';
	}

	const promptElements = nonEmpty.map(formatPrompt).join('\n');
	return `<prompts>\n${promptElements}\n</prompts>`;
}

// Legacy exports for backwards compatibility during migration
export type ExtractedComment = { id: string; content: string };

/**
 * @deprecated Use HtmlAnnotator.getAnnotation() and formatAllPrompts() instead
 */
export function extractComments(markdown: string): {
	comments: ExtractedComment[];
	markdown: string;
} {
	console.warn('extractComments is deprecated. Use HtmlAnnotator.getAnnotation() instead.');
	const comments: ExtractedComment[] = [];
	const annotationRegex =
		/<x-annotation([^>]*id="([^"]+)"[^>]*)>[\s\S]*?<x-comment>([\s\S]*?)<\/x-comment><\/x-annotation>/g;

	let match;
	while ((match = annotationRegex.exec(markdown)) !== null) {
		const id = match[2];
		const commentContent = match[3];
		// Remove msg/x-by discussion elements, keep only editable content
		const contentWithoutDiscussion = commentContent
			.replace(/<msg[^>]*>[\s\S]*?<\/msg>/g, '')
			.replace(/<x-by[^>]*>[\s\S]*?<\/x-by>/g, '')
			.trim();

		if (contentWithoutDiscussion) {
			comments.push({ id, content: contentWithoutDiscussion });
		}
	}

	return { comments, markdown };
}

/**
 * @deprecated Use formatAllPrompts() instead
 */
export function formatCommentList(comments: ExtractedComment[]): string {
	console.warn('formatCommentList is deprecated. Use formatAllPrompts() instead.');
	if (comments.length === 0) return '<prompts>\n(no comments)\n</prompts>';

	const promptElements = comments
		.map(({ content, id }) => {
			const escapedContent = content.replace(/\n/g, ' ').trim();
			return `<prompt href="${id}">${escapedContent}</prompt>`;
		})
		.join('\n');

	return `<prompts>\n${promptElements}\n</prompts>`;
}
