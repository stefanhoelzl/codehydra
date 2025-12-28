# MarkdownReviewEditor

AI-assisted collaborative markdown document editor, built as a VS Code extension with Svelte 5 webview.

## Project Overview

MarkdownReviewEditor is a VS Code extension that enables users to collaboratively author markdown documents with AI assistance. The extension communicates with OpenCode to process user feedback and modify the document accordingly.

### Core Workflow

1. **View**: User views the markdown document rendered as HTML in a webview (readonly)
2. **Annotate**: User selects text and provides feedback via keyboard shortcuts
3. **Apply**: User clicks "Apply" to send all pending changes/comments to OpenCode
4. **Review**: AI processes requests and displays changes with visual diff highlighting
5. **Iterate**: User reviews changes, adds more comments, or closes answered questions
6. **Implement**: When satisfied (no open comments), user clicks "Implement" to finalize

### Comment System

- Comments appear as bubbles in a sidebar aligned with the selected text
- **Edit bubbles**: Allow direct markdown editing of the selected text
- **Comment bubbles**: For feedback, suggestions, or questions
- Questions receive AI-generated answers that remain visible until user closes them
- Regular comments are removed after AI processes them

### Change Visualization

After OpenCode processes changes:

- **Deleted text**: Red with strikethrough
- **Added text**: Green
- **Modified text**: Blue

### Keyboard Shortcuts

| Key     | Action                                          |
| ------- | ----------------------------------------------- |
| `Del`   | Request deletion of selected text               |
| `Enter` | Edit selected text directly (opens edit bubble) |
| `C`     | Add comment or question about selected text     |

## Tech Stack

- **Platform**: VS Code Extension
- **UI**: Svelte 5 (runes only - no legacy reactive statements) in webview
- **AI Backend**: OpenCode SDK integration
- **Rendering**: Markdown to HTML
- **Testing**: Vitest
- **Language**: TypeScript
- **Formatting**: Prettier
- **Build**: Vite (webview) + esbuild (extension)

## Development Guidelines

### Svelte 5 Runes

This project uses Svelte 5 exclusively. Use runes for all reactivity.
Do NOT use legacy Svelte syntax (`$:`, `export let`, stores with `$` prefix).

### File Structure

```
src/
├── extension/                  # VS Code extension host code (Node.js)
│   ├── extension.ts           # Extension entry point (activate/deactivate)
│   ├── custom-editor-provider.ts # CustomEditorProvider for file-bound .md editing
│   ├── virtual-document-provider.ts # Virtual document with workspace state persistence
│   ├── webview-manager.ts     # Shared webview creation and message handling
│   ├── webview-panel.ts       # Legacy wrapper (deprecated, uses VirtualDocumentProvider)
│   ├── demo-content.ts        # Demo markdown and annotations for first-time use
│   ├── opencode-handler.ts    # OpenCode SDK integration
│   ├── message-types.ts       # Shared message type definitions
│   └── logger.ts              # Logging utility (OutputChannel + file)
├── webview/                    # Webview code (runs in browser context)
│   ├── main.ts                # Webview entry point
│   └── App.svelte             # Main application component
├── lib/
│   ├── components/
│   │   ├── HtmlAnnotator.svelte  # HTML display with selection snapping
│   │   ├── CommentEditor.svelte  # Editable comment textarea in sidebar
│   │   └── annotation-elements.ts # Custom elements (x-annotation, x-comment)
│   ├── services/
│   │   └── opencode-client.ts # Message-passing client for webview
│   ├── styles/
│   │   ├── theme.css          # VS Code design language CSS variables
│   │   └── theme.ts           # Theme utilities (inherits VS Code theme)
│   └── utils/
│       ├── html-to-markdown.ts # HTML to markdown conversion (turndown)
│       ├── document-storage.ts # Load/store document serialization
│       ├── html-diff.ts       # Document comparison with x-modified tags
│       ├── selection.ts       # Text selection snapping algorithm
│       ├── answer-processing.ts # Extract x-answer tags from AI responses
│       ├── annotation-state-update.ts # Update annotations based on answers
│       ├── opencode.ts        # Orchestrates AI communication
│       ├── opencode-prompt.ts # Prompt building
│       └── opencode-comment-extraction.ts # Format annotations for prompts
tests/
├── unit/                      # Vitest unit tests
│   ├── selection.test.ts
│   ├── HtmlAnnotator.test.ts
│   ├── CommentEditor.test.ts
│   ├── annotation-elements.test.ts
│   ├── answer-processing.test.ts
│   ├── annotation-state-update.test.ts
│   ├── document-storage.test.ts
│   └── html-diff.test.ts
└── e2e/                       # Playwright E2E tests (future)
```

## Commands

```bash
npm run dev            # Watch mode for both extension and webview
npm run build          # Build for production
npm run build:extension # Build extension only
npm run build:webview  # Build webview only
npm run test           # Run unit tests (Vitest)
npm run test:e2e       # Run E2E tests (Playwright)
npm run format         # Format code with Prettier
npm run lint           # Check linting
npm run package        # Package extension (.vsix)
```

## Running the Extension

1. Build the extension: `npm run build`
2. Open VS Code in this folder
3. Press F5 to launch Extension Development Host
4. **Virtual Mode**: Run command: "Markdown Review: Open Markdown Review Editor"
5. **File Mode**: Open any `.md` file (opens with Markdown Review Editor by default)

## Architecture

### Message Passing

The webview and extension host communicate via message passing:

```
Webview (browser)                    Extension Host (Node.js)
      │                                      │
      ├── postMessage({                      │
      │     type: 'createSession',           │
      │     requestId: '...'                 │
      │   })                                 │
      │ ──────────────────────────────────────►
      │                                      ├── Call OpenCode SDK
      │                                      │
      │  ◄────────────────────────────────────┤
      │      { type: 'sessionCreated',       │
      │        requestId: '...',             │
      │        sessionId: '...' }            │
```

### Theme Integration

The webview inherits the VS Code theme automatically:

- Extension host detects `vscode.window.activeColorTheme`
- Sends theme updates to webview via `themeChanged` message
- CSS variables in `theme.css` map to light/dark themes

### Logging

The extension uses a centralized logger (`src/extension/logger.ts`) that writes to:

1. **VS Code OutputChannel**: "Markdown Review Editor" (View → Output → select from dropdown)
2. **File**: `server.log` in the workspace folder (cleared on each launch via F5)

Usage in extension code:

```typescript
import { logger } from './logger';

logger.info('Message here');
logger.debug('Debug info', { someData: 123 });
logger.warn('Warning message');
logger.error('Error occurred', error);
```

Webview logs are forwarded to the extension logger via the `log` message type.

## Rules

- Always run prettier and unit tests after modifying code by coding agent
- When implementing a feature, always update the "Current Implementation Status" section to reflect the changes made
- Use VS Code design language for UI styling (dark mode and light mode support)
- All colors must use CSS custom properties from `theme.css` (e.g., `var(--color-bg-primary)`)
- Unit tests go in `tests/unit/`, E2E tests go in `tests/e2e/`

## Current Implementation Status

- **VS Code Extension Architecture**:
  - Extension entry point with command registration
  - Webview panel with message passing
  - OpenCode SDK integration in extension host
  - Theme synchronization with VS Code
- HtmlAnnotator component with VS Code theming (dark/light mode)
- Selection snapping algorithm (prevents partial element selection)
- Theme system with CSS custom properties (inherits from VS Code)
- Demo page with comprehensive HTML content (all markdown elements including tables)
- Unit tests for selection utilities and component behavior
- **Annotation system**:
  - Custom elements (`<x-annotation>`, `<x-comment>`, `<x-by>`) for tracking document changes
  - Auto-annotation on text selection (mouseup or Shift keyup)
  - Light blue background + underline highlighting for annotated text
  - Sidebar with comment bubbles aligned to annotations
  - Close button to remove annotations (unwraps text back to normal)
  - `wrapSelectionWithAnnotation()` and `removeAnnotation()` utilities
  - **Discussion threads**: `<x-by author="xxx">` elements in comments display as read-only discussion history
- **CommentEditor component**:
  - Auto-resizing textarea for markdown comments
  - ESC key behavior: empty content removes annotation and restores selection on unwrapped text
  - Tab/Shift-Tab navigation between comment editors
  - Blur saves content to `<x-comment>` element's textContent
  - Exported `focus()` method for programmatic focus
  - VS Code themed styling with CSS variables
  - **Discussion thread display**: First message unindented, subsequent messages + textarea indented 2em with bold "reply:" prefix
- **Keyboard navigation**:
  - Tab in content area: focuses next annotation's editor (or current if cursor inside annotation)
  - Shift-Tab in content area: focuses previous annotation's editor
  - Tab/Shift-Tab in editor: navigates to next/previous editor (stops at edges, no wrap)
  - ESC in editor: removes annotation (if empty) and restores selection on unwrapped text
- **WYSIWYG editing**:
  - Content area is directly editable (contenteditable with no input blocking)
  - Content changes trigger `onContentChange` callback
  - Editing works both inside and outside annotations
  - Selection workflow: select text → annotation created → ESC restores selection for editing
- **Answer processing**:
  - AI returns answers in `<answer href="annotation-id"><msg author="...">...</msg></answer>` tags
  - `processAnswers()` extracts answers and returns `AnnotationContent[]` with full message history
  - `HtmlAnnotator.setAnnotation(id, content)` updates annotation state with new messages
  - Discussion threads grow with each Q&A cycle, preserving prior messages
  - Textarea remains visible after answer for follow-up questions
- **Markdown formatting in x-by content**:
  - `annotated_md2html()` converts markdown to HTML inside `<x-by>` elements (bold, italic, code, links)
  - `annotated_html2md()` converts HTML back to markdown for sending to OpenCode
  - CommentEditor renders x-by content as formatted HTML with appropriate styling
- **Dual-Mode Document Architecture**:
  - **Virtual Mode**: Command-based editor with demo content and workspace state persistence
    - Opens via command palette: "Open Markdown Review Editor"
    - First open shows demo content, subsequent opens restore previous state
    - Auto-saves to workspace state on: Apply Comments, panel hidden, panel close, extension deactivate
    - "Save As..." button available for exporting to file
  - **File Mode**: Custom editor for `.md` files with native VS Code integration
    - Opens automatically when opening any `.md` file (registered as default editor)
    - Full Ctrl+S / "Save As..." support with VS Code's dirty indicator
    - External file change detection with reload prompt
    - Backup support for hot exit recovery
  - Shared webview code between both modes via `webview-manager.ts`
  - Two-section markdown file format:
    - Section 1: Discussions as `<discussion href="id"><msg author="...">...</msg></discussion>`
    - Section 2: Document with `<x-annotation id="...">` markers (separated by `----`)
  - `serializeDocument()` and `deserializeDocument()` utilities in `document-storage.ts`
  - `documentHtmlToMarkdown()` and `documentMarkdownToHtml()` for annotation-preserving conversion
- **Document diff comparison**:
  - `setDocument(html, baseHtml?)` accepts optional base HTML for comparison
  - Uses diff-match-patch for character-level text comparison
  - Changes marked with `<x-modified>` custom element:
    - `type="add"`: Green background for new text
    - `type="change"`: Blue background with tooltip showing previous text
    - `type="del"`: Red strikethrough showing deleted text
  - 5-word merging: Nearby changes within 5 words merge into single x-modified tag
  - Boundary splitting: x-modified tags split at HTML element boundaries to maintain valid structure
  - **Block element normalization**: Post-processing ensures proper x-modified placement:
    - x-modified tags never span multiple block elements (p, div, li, h1-h6, etc.)
    - If x-modified contains multiple blocks, it's split into separate wrappers per block
    - If x-modified wraps the entire content of a block, the block itself gets wrapped instead
    - Partial changes within a block keep x-modified inside the block
  - `getDocument()` strips x-modified tags for clean output
  - CSS styling with theme-aware colors (light/dark mode support)

## Future Upgrades

See `todos.md` for planned enhancements:

- Command palette integration
- Status bar integration
- Settings UI
