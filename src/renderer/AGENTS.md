# Renderer (Svelte UI)

Svelte 5 + TypeScript + `@vscode-elements`. Full patterns (IPC, VSCode Elements, CSS theming, setup functions): `docs/PATTERNS.md`.

## Layout

```
src/renderer/lib/
├── api/          # Re-exports window.api for mockability
├── components/   # Svelte 5 components (form/ holds the dialog form sections)
├── logging/      # Renderer logger (forwards to main as a `log` ui:event)
├── services/     # Renderer-local behavior (agent chime)
├── utils/        # Pure helpers and setup* functions (focus, keyboard, sidebar, domain-event bindings)
└── styles/       # Global CSS (global.css, variables.css)
```

## State

- Import from `$lib/api`, not `window.api`.
- No stores: `App.svelte` holds the `UiState` snapshot from `api.onState` and passes it down as props. Only ephemeral state (hover, focus, in-flight edits) is component-local.
- Svelte 5 runes: `$state`, `$derived`, `$effect`.

## VSCode Elements

- Use `@vscode-elements/elements` where an equivalent exists: `<vscode-button>`, `<vscode-textfield>`, `<vscode-checkbox>` instead of native HTML.
- Property binding: `value={x} oninput={...}`, not `bind:value`.

## Icons

Use the `Icon` component (wraps `<vscode-icon>`, codicon names). Never Unicode characters or HTML entities.

```svelte
<Icon name="check" />
<Icon name="sync" spin />
```

## CSS theming

- Variable prefix `--ch-*` (e.g. `--ch-foreground`), defined in `lib/styles/variables.css`.
- VS Code fallback: `var(--vscode-foreground, #cccccc)`.
- Screen-reader text: `.ch-visually-hidden`.
