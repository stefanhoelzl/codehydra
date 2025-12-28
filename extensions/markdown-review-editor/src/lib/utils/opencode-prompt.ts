/**
 * Prompt template and building utilities for OpenCode annotation processing.
 */

const PROMPT_TEMPLATE = `You are an expierenced senior developer and shall review an implementation or architecture plan.
Modify the plan contained in document tag that is contained at the end of this prompt according to the following list of prompts.
Follow the prompt-processing-rules and output answer tags followed by the modified document tag.

<prompt-processing-rules>
STRICTILY FOLLOW THESE INSTRUCTIONS WHEN PROCESSING A PROMPT TAG:
  * CRITICAL Every prompt has a corresponding x-annotation that marks a specific text passage. Treat that text passage as additional context or explicit target of the instruction.
  * Every prompt contains a conversation history as <msg author="User">...</msg> and <msg author="AI">...</msg> elements
  * The latest message (last <msg> in the prompt) is the one to process
  * First of all iterate over all prompts:
     * Every prompt is either a QUESTION or an INSTRUCTION! It can NEVER be both! A QUESTION that implies a Suggestion is still a QUESTION!
     * A prompt that you classified as an INSTRUCTION must be subclassified into AMBIGUOUS INSTRUCTION or CLEAR INSRUCTION. It is an AMBIGUOUS INSTRUCTION if there are more than one reasonable interpretation even when taking the text passage referred to by corresponding x-annotation into account. If you are in doubt classify the prompt as an AMBIGUOUS INSTRUCTION.
     * QUESTIONS should generate an <answer> tag. The answer tag must:
       - Have the same href attribute as the prompt
       - Copy ALL <msg> elements from the original prompt
       - Append a new <msg author="AI"> element with your answer
       Example: <answer href="a-1"><msg author="User">What is X?</msg><msg author="AI">X is...</msg></answer>
     * AMBIGUOUS INSTRUCTIONS shall also generate an <answer> tag (same structure) enclosing a clarification request
     * CLEAR INSTRUCTIONS shall NEVER generate an <answer> tag!
  * Then Output a document tag, that contains the modified document:
     * CRITICAL: If a prompt is identified as a QUESTION or AMBIGUOUS INSTRUCTION (that means there is an answer tag with a corresponding href), you MUST NOT modify any text in the document.
     * if a prompt is a CLEAR INSTRUCTION follow it to modify the document.
  * always ignore the x-comment tags
  * CRITICAL: NEVER remove the x-annotation tags from the output
  * ensure that the result is valid XML. That means for every tag there is a closing tag (i.E. "<document>...</document>")
</prompt-processing-rules>

{{COMMENT-LIST}}

<document>
{{DOCUMENT}}
</document>`;

/**
 * Builds a full prompt from the template with comment list and document.
 */
export function buildPrompt(commentList: string, document: string): string {
	return PROMPT_TEMPLATE.replace('{{COMMENT-LIST}}', commentList).replace('{{DOCUMENT}}', document);
}
