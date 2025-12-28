/**
 * Demo content for the Markdown Review Editor.
 * Used when opening virtual document for the first time.
 */

import type { AnnotationContent } from '../lib/utils/annotation-types';

/**
 * Demo annotations with sample user comments and questions.
 */
export function getDemoAnnotations(): AnnotationContent[] {
	return [
		{ id: 'a-1', messages: [{ author: 'User', content: 'use an older svelte version' }] },
		{ id: 'a-2', messages: [{ author: 'User', content: 'Convert to uppercase' }] },
		{
			id: 'a-3',
			messages: [
				{
					author: 'User',
					content: 'Should we also include a FilterBar component for filtering by status?'
				}
			]
		},
		{
			id: 'a-4',
			messages: [
				{
					author: 'User',
					content: 'Add a third state for "Review later". User can switch though states via click'
				}
			]
		},
		{
			id: 'a-5',
			messages: [{ author: 'User', content: 'What could be a good Icon for this button' }]
		},
		{
			id: 'a-6',
			messages: [{ author: 'User', content: 'Do have proposals for alternative workflows' }]
		},
		{
			id: 'a-7',
			messages: [
				{ author: 'User', content: 'Add error handling for storage quota exceeded scenarios' }
			]
		},
		{
			id: 'a-8',
			messages: [
				{
					author: 'User',
					content: 'Implement inline editing with double-click to edit and blur/Enter to save'
				}
			]
		}
	];
}

/**
 * Demo markdown document with annotation markers.
 */
export function getDemoMarkdown(): string {
	return `# Todo App Implementation Plan

## Overview

Build a simple todo application using <x-annotation id="a-1">Svelte 5 with runes</x-annotation> for state management.

## Tech Stack

- Svelte 5 with runes ($state, $derived)
- TypeScript for type safety
- <x-annotation id="a-2">Local storage for persistence</x-annotation>

## Component Structure

### 1. App.svelte (Main Container)

- Initialize the todo list state using $state rune
- Handle adding, removing, and toggling todos
- <x-annotation id="a-3">Render TodoList and AddTodo components</x-annotation>

### 2. TodoList.svelte

- Accept todos array as prop
- Map over todos and render TodoItem for each
- Handle empty state with friendly message

### 3. TodoItem.svelte

- Display todo text with checkbox
- <x-annotation id="a-4">Toggle completion status on click</x-annotation>
- <x-annotation id="a-5">Delete button</x-annotation> to remove todo
- Visual styling for completed items (strikethrough)

### 4. AddTodo.svelte

- Text input for new todo
- Submit button or Enter key to add
- <x-annotation id="a-6">Clear input after submission</x-annotation>
- Validate non-empty input

## Data Model

\`\`\`typescript
interface Todo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: Date;
}
\`\`\`

## Features

### Core Features

- Add new todos
- Mark todos as complete/incomplete
- Delete todos
- <x-annotation id="a-7">Persist todos to local storage</x-annotation>

### Enhanced Features

- Filter by status (all, active, completed)
- Clear all completed todos
- <x-annotation id="a-8">Edit existing todo text</x-annotation>
- Todo count display

## Styling

- Clean, minimal design
- Responsive layout
- Hover states for interactive elements
- Smooth transitions for status changes

## Testing

- Unit tests for todo operations
- Component tests for user interactions
- E2E tests for full workflow
`;
}
