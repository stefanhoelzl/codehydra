/**
 * Document storage utilities for serializing/deserializing annotated documents.
 *
 * The storage format consists of two sections separated by "----":
 * 1. Discussions section: <discussion href="id"><msg author="...">...</msg></discussion>
 * 2. Document section: Markdown with <x-annotation id="...">content</x-annotation>
 */

import type { AnnotationContent, Message } from './annotation-types';
import { documentHtmlToMarkdown, documentMarkdownToHtml } from './html-to-markdown';

const SECTION_SEPARATOR = '\n\n----\n\n';

/**
 * Serialize a document and its annotations to the two-section markdown format.
 *
 * @param documentHtml - HTML document with x-annotation elements (no x-comment)
 * @param annotations - Array of annotation contents with their messages
 * @returns Two-section markdown string
 */
export function serializeDocument(documentHtml: string, annotations: AnnotationContent[]): string {
	// Build discussions section
	const discussions = annotations
		.filter((a) => a.messages.length > 0)
		.map((annotation) => {
			const msgs = annotation.messages
				.map((msg) => `  <msg author="${msg.author}">${msg.content}</msg>`)
				.join('\n');
			return `<discussion href="${annotation.id}">\n${msgs}\n</discussion>`;
		})
		.join('\n\n');

	// Convert document HTML to markdown
	const documentMarkdown = documentHtmlToMarkdown(documentHtml);

	// Combine sections
	if (discussions.length > 0) {
		return discussions + SECTION_SEPARATOR + documentMarkdown;
	} else {
		return documentMarkdown;
	}
}

/**
 * Deserialize a two-section markdown format into document HTML and annotations.
 *
 * @param markdown - Two-section markdown with discussions and document
 * @returns Object with document HTML and annotations array
 */
export function deserializeDocument(markdown: string): {
	documentHtml: string;
	annotations: AnnotationContent[];
} {
	// Split by separator - only split on first occurrence
	const separatorIndex = markdown.indexOf('----');
	let discussionsSection = '';
	let documentSection = markdown;

	if (separatorIndex !== -1) {
		// Check if there's content before the separator that looks like discussions
		const beforeSeparator = markdown.substring(0, separatorIndex).trim();
		if (beforeSeparator.includes('<discussion')) {
			discussionsSection = beforeSeparator;
			documentSection = markdown.substring(separatorIndex + 4).trim();
		}
	}

	// Parse discussions
	const annotations: AnnotationContent[] = [];
	if (discussionsSection) {
		const discussionRegex = /<discussion\s+href="([^"]+)"\s*>([\s\S]*?)<\/discussion>/g;
		const msgRegex = /<msg\s+author="([^"]+)"\s*>([\s\S]*?)<\/msg>/g;

		let discussionMatch;
		while ((discussionMatch = discussionRegex.exec(discussionsSection)) !== null) {
			const id = discussionMatch[1];
			const discussionContent = discussionMatch[2];

			const messages: Message[] = [];
			let msgMatch;
			while ((msgMatch = msgRegex.exec(discussionContent)) !== null) {
				messages.push({
					author: msgMatch[1],
					content: msgMatch[2].trim()
				});
			}

			if (messages.length > 0) {
				annotations.push({ id, messages });
			}
		}
	}

	// Convert document markdown to HTML
	const documentHtml = documentMarkdownToHtml(documentSection);

	return { documentHtml, annotations };
}
