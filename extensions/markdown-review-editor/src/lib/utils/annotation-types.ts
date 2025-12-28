/**
 * Shared type definitions for annotation data flow between HtmlAnnotator and OpenCode.
 */

/**
 * A single message in an annotation conversation.
 */
export interface Message {
	/** The author of the message ("User" or "AI") */
	author: string;
	/** The message content */
	content: string;
}

/**
 * Content of an annotation, used for both prompts sent to OpenCode
 * and answers received from OpenCode. The structure is identical:
 * a list of messages in conversation order.
 */
export interface AnnotationContent {
	/** The annotation ID */
	id: string;
	/** The conversation messages */
	messages: Message[];
}
