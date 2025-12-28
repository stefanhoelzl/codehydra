/**
 * HTML to Markdown conversion utility
 *
 * Uses turndown to convert HTML content to markdown format.
 * Used by the direct-edit mode to convert annotated HTML to editable markdown.
 */

import TurndownService from 'turndown';
import { marked } from 'marked';

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	emDelimiter: '_',
	strongDelimiter: '**'
});

// Configure marked for synchronous operation
marked.use({ async: false });

/**
 * Convert markdown string to HTML.
 * Uses marked.parse for block content.
 * @param markdown - Markdown string to convert
 * @returns HTML string
 */
export function markdownToHtml(markdown: string): string {
	return marked.parse(markdown) as string;
}

/**
 * Convert x-by content from markdown to HTML within a comment string.
 * @param comment - Comment string containing x-by elements with markdown content
 * @returns Comment string with x-by content converted to HTML
 */
function convertXByMdToHtml(comment: string): string {
	const xByRegex = /<x-by\s+author="([^"]*)">([\s\S]*?)<\/x-by>/g;
	return comment.replace(xByRegex, (_, author, content) => {
		const htmlContent = marked.parse(content) as string;
		return `<x-by author="${author}">${htmlContent}</x-by>`;
	});
}

/**
 * Convert x-by content from HTML to markdown within a comment string.
 * @param comment - Comment string containing x-by elements with HTML content
 * @returns Comment string with x-by content converted to markdown
 */
function convertXByHtmlToMd(comment: string): string {
	const xByRegex = /<x-by\s+author="([^"]*)">([\s\S]*?)<\/x-by>/g;
	return comment.replace(xByRegex, (_, author, content) => {
		const mdContent = turndown.turndown(content);
		return `<x-by author="${author}">${mdContent}</x-by>`;
	});
}

/**
 * Convert HTML string to markdown
 *
 * @param html - HTML string to convert
 * @returns Markdown representation of the HTML
 */
export function htmlToMarkdown(html: string): string {
	return turndown.turndown(html);
}

/**
 * Convert annotated HTML to markdown, preserving x-annotation and x-comment tags.
 * The content inside annotations is converted to markdown, but comment text is kept as-is.
 *
 * @param html - HTML string with x-annotation elements
 * @returns Markdown string with preserved x-annotation/x-comment tags
 */
export function annotated_html2md(html: string): string {
	// Use regex to find and process annotations
	// Pattern matches <x-annotation...>content<x-comment>comment</x-comment></x-annotation>
	const annotationRegex =
		/<x-annotation([^>]*)>([\s\S]*?)<x-comment>([\s\S]*?)<\/x-comment><\/x-annotation>/g;

	// Store annotations with placeholders
	const annotations: Array<{ attrs: string; content: string; comment: string }> = [];

	// Replace annotations with placeholders and store them
	// Use alphanumeric placeholder to avoid escaping by turndown
	const htmlWithPlaceholders = html.replace(annotationRegex, (_, attrs, content, comment) => {
		const index = annotations.length;
		annotations.push({ attrs, content, comment });
		return `XANNOTATIONPLACEHOLDER${index}X`;
	});

	// Convert the remaining HTML to markdown
	let markdown = turndown.turndown(htmlWithPlaceholders);

	// Restore annotations with converted content
	for (let i = 0; i < annotations.length; i++) {
		const { attrs, content, comment } = annotations[i];
		// Convert the annotation content from HTML to markdown
		const contentMd = turndown.turndown(content);
		// Convert x-by content within comment from HTML to markdown
		const commentMd = convertXByHtmlToMd(comment);
		// Reconstruct the annotation with markdown content
		const annotationMd = `<x-annotation${attrs}>${contentMd}<x-comment>${commentMd}</x-comment></x-annotation>`;
		markdown = markdown.replace(`XANNOTATIONPLACEHOLDER${i}X`, annotationMd);
	}

	return markdown;
}

/**
 * Convert markdown with annotations to HTML, preserving x-annotation and x-comment tags.
 * The content inside annotations is converted to HTML, but comment text is kept as-is.
 *
 * @param markdown - Markdown string with x-annotation elements
 * @returns HTML string with preserved x-annotation/x-comment tags
 */
export function annotated_md2html(markdown: string): string {
	// Pattern matches <x-annotation...>content<x-comment>comment</x-comment></x-annotation>
	const annotationRegex =
		/<x-annotation([^>]*)>([\s\S]*?)<x-comment>([\s\S]*?)<\/x-comment><\/x-annotation>/g;

	// Store annotations with placeholders
	const annotations: Array<{ attrs: string; content: string; comment: string }> = [];

	// Replace annotations with placeholders and store them
	// Use alphanumeric placeholder to avoid being interpreted as bold by marked
	const mdWithPlaceholders = markdown.replace(annotationRegex, (_, attrs, content, comment) => {
		const index = annotations.length;
		annotations.push({ attrs, content, comment });
		return `XANNOTATIONPLACEHOLDER${index}X`;
	});

	// Convert the remaining markdown to HTML
	let html = marked.parse(mdWithPlaceholders) as string;

	// Restore annotations with converted content
	for (let i = 0; i < annotations.length; i++) {
		const { attrs, content, comment } = annotations[i];
		// Convert the annotation content from markdown to HTML
		// Use parseInline to avoid wrapping in <p> tags
		const contentHtml = marked.parseInline(content) as string;
		// Convert x-by content within comment from markdown to HTML
		const commentHtml = convertXByMdToHtml(comment);
		// Reconstruct the annotation with HTML content
		const annotationHtml = `<x-annotation${attrs}>${contentHtml}<x-comment>${commentHtml}</x-comment></x-annotation>`;
		html = html.replace(`XANNOTATIONPLACEHOLDER${i}X`, annotationHtml);
	}

	return html;
}

/**
 * Convert document HTML to markdown, preserving x-annotation tags without x-comment.
 * This is used for the document storage format where discussions are stored separately.
 *
 * @param html - HTML string with x-annotation elements (no x-comment)
 * @returns Markdown string with preserved x-annotation tags
 */
export function documentHtmlToMarkdown(html: string): string {
	// Pattern matches <x-annotation id="...">content</x-annotation> without x-comment
	const annotationRegex = /<x-annotation([^>]*)>([\s\S]*?)<\/x-annotation>/g;

	// Store annotations with placeholders
	const annotations: Array<{ attrs: string; content: string }> = [];

	// Replace annotations with placeholders and store them
	const htmlWithPlaceholders = html.replace(annotationRegex, (_, attrs, content) => {
		const index = annotations.length;
		annotations.push({ attrs, content });
		return `XANNOTATIONPLACEHOLDER${index}X`;
	});

	// Convert the remaining HTML to markdown
	let markdown = turndown.turndown(htmlWithPlaceholders);

	// Restore annotations with converted content
	for (let i = 0; i < annotations.length; i++) {
		const { attrs, content } = annotations[i];
		// Convert the annotation content from HTML to markdown
		const contentMd = turndown.turndown(content);
		// Reconstruct the annotation with markdown content (no x-comment)
		const annotationMd = `<x-annotation${attrs}>${contentMd}</x-annotation>`;
		markdown = markdown.replace(`XANNOTATIONPLACEHOLDER${i}X`, annotationMd);
	}

	return markdown;
}

/**
 * Convert markdown to HTML, preserving x-annotation tags without x-comment.
 * This is used for the document storage format where discussions are stored separately.
 *
 * @param markdown - Markdown string with x-annotation elements (no x-comment)
 * @returns HTML string with preserved x-annotation tags
 */
export function documentMarkdownToHtml(markdown: string): string {
	// Pattern matches <x-annotation id="...">content</x-annotation> without x-comment
	const annotationRegex = /<x-annotation([^>]*)>([\s\S]*?)<\/x-annotation>/g;

	// Store annotations with placeholders
	const annotations: Array<{ attrs: string; content: string }> = [];

	// Replace annotations with placeholders and store them
	const mdWithPlaceholders = markdown.replace(annotationRegex, (_, attrs, content) => {
		const index = annotations.length;
		annotations.push({ attrs, content });
		return `XANNOTATIONPLACEHOLDER${index}X`;
	});

	// Convert the remaining markdown to HTML
	let html = marked.parse(mdWithPlaceholders) as string;

	// Restore annotations with converted content
	for (let i = 0; i < annotations.length; i++) {
		const { attrs, content } = annotations[i];
		// Convert the annotation content from markdown to HTML
		// Use parseInline to avoid wrapping in <p> tags
		const contentHtml = marked.parseInline(content) as string;
		// Reconstruct the annotation with HTML content (no x-comment)
		const annotationHtml = `<x-annotation${attrs}>${contentHtml}</x-annotation>`;
		html = html.replace(`XANNOTATIONPLACEHOLDER${i}X`, annotationHtml);
	}

	return html;
}
