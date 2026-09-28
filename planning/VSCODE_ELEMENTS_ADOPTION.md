---
status: CLEANUP
last_updated: 2025-12-14
reviewers: [review-ui, review-arch, review-senior, review-docs]
---

# VSCODE_ELEMENTS_ADOPTION

## Overview

- **Problem**: `@vscode-elements/elements` v2.3.1 is installed but completely unused. All UI is implemented with native HTML elements and custom CSS. This creates inconsistency with VS Code's native appearance, duplicated styling code across components, and violates the tech stack declaration in AGENTS.md which lists "@vscode-elements" as part of the frontend stack. Note: `docs/USER_INTERFACE.md` incorrectly states vscode-elements is already implemented - this plan corrects that.

- **Solution**: Systematically replace native HTML elements with vscode-elements web components, unify duplicated CSS, update documentation to mandate vscode-elements usage, and enhance the review-ui agent to enforce this standard.

- **Risks**:

  | Risk                                                    | Mitigation                                                                          |
  | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | vscode-elements styling conflicts with --ch-_ variables | Test in isolation first; inject --vscode-_ fallbacks at :root for standalone mode   |
  | BranchDropdown custom features lost                     | Keep custom implementation; vscode-single-select doesn't support filtering/grouping |
  | Breaking existing functionality                         | TDD approach: write tests for current behavior before migrating                     |
  | Web component event handling in Svelte                  | Use Svelte's `on:event` syntax for custom events (e.g., `on:vsc-input`)             |
  | vscode-toolbar may conflict with hover-reveal           | Research toolbar CSS behavior; may need custom CSS override                         |
  | vscode-badge has no built-in dimmed state               | Use custom CSS for dimmed badges (documented exception)                             |

- **Alternatives Considered**:

  | Alternative                      | Rejected Because                                              |
  | -------------------------------- | ------------------------------------------------------------- |
  | Remove @vscode-elements entirely | Violates declared tech stack; loses native VS Code appearance |
  | Partial adoption (buttons only)  | Inconsistent; doesn't address duplication                     |
  | vscode-elements-lite (CSS-only)  | Less semantic; doesn't provide full component behavior        |

- **Rollback Criteria**: If vscode-elements causes visual regressions in code-server context, or if testing reveals fundamental incompatibility with Svelte 5, pause and reassess approach.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         RENDERER ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  main.ts                                                                 │
│    │                                                                     │
│    ├── import './lib/vscode-elements-setup.ts'  ← NEW (isolated setup)  │
│    ├── import './lib/styles/variables.css'                              │
│    ├── import './lib/styles/global.css'                                 │
│    └── mount(App)                                                        │
│                                                                          │
│  lib/vscode-elements-setup.ts  ← NEW                                    │
│    └── import '@vscode-elements/elements/dist/bundled.js'               │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                     COMPONENT HIERARCHY                           │   │
│  │                                                                    │   │
│  │  App.svelte                                                        │   │
│  │    ├── SetupScreen.svelte                                          │   │
│  │    │     ├── <vscode-progress-bar>   ← replaces custom bar        │   │
│  │    │     └── SetupError.svelte                                     │   │
│  │    │           ├── <vscode-button>   ← replaces <button>          │   │
│  │    │           └── <vscode-button secondary>                       │   │
│  │    │                                                               │   │
│  │    └── MainView.svelte                                             │   │
│  │          ├── ShortcutOverlay.svelte                                │   │
│  │          │     └── <vscode-badge> × 5 ← replaces hint spans       │   │
│  │          │                                                         │   │
│  │          ├── Sidebar.svelte                                        │   │
│  │          │     ├── <vscode-progress-ring> ← replaces spinner      │   │
│  │          │     ├── <vscode-divider>   ← replaces border-bottom    │   │
│  │          │     ├── <vscode-toolbar>   ← wraps project actions     │   │
│  │          │     │     ├── <vscode-button icon> ← add workspace     │   │
│  │          │     │     └── <vscode-button icon> ← close project     │   │
│  │          │     ├── <vscode-badge>     ← shortcut index (1-0, O)   │   │
│  │          │     └── <vscode-button>    ← Open Project              │   │
│  │          │                                                         │   │
│  │          ├── Dialog.svelte (base)                                  │   │
│  │          │                                                         │   │
│  │          ├── CreateWorkspaceDialog.svelte                          │   │
│  │          │     ├── <vscode-textfield>  ← replaces <input>         │   │
│  │          │     ├── <vscode-form-helper> ← replaces error span     │   │
│  │          │     ├── BranchDropdown.svelte (KEEP CUSTOM)             │   │
│  │          │     ├── <vscode-button>                                 │   │
│  │          │     └── <vscode-button secondary>                       │   │
│  │          │                                                         │   │
│  │          └── RemoveWorkspaceDialog.svelte                          │   │
│  │                ├── <vscode-checkbox>   ← replaces <input checkbox>│   │
│  │                ├── <vscode-button>                                 │   │
│  │                └── <vscode-button secondary>                       │   │
│  │                                                                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## UI Design

### Button Migration

**Before (native HTML):**

```
┌─────────────────────────────────────────────────────────────────┐
│  [  Retry  ]    [  Quit  ]                                      │
│   .button--primary   .button--secondary                         │
│   (custom CSS)       (custom CSS)                               │
└─────────────────────────────────────────────────────────────────┘
```

**After (vscode-elements):**

```
┌─────────────────────────────────────────────────────────────────┐
│  [ Retry ]    [ Quit ]                                          │
│  <vscode-button>  <vscode-button secondary>                     │
│  (no custom CSS)  (no custom CSS)                               │
└─────────────────────────────────────────────────────────────────┘
```

### Progress Bar Migration (SetupScreen)

**Before (custom CSS animation):**

```
┌─────────────────────────────────────────────────────────────────┐
│         Setting up VSCode...                                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│   │  ← Custom indeterminate bar
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**After (vscode-progress-bar):**

```
┌─────────────────────────────────────────────────────────────────┐
│         Setting up VSCode...                                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│   │  ← <vscode-progress-bar indeterminate>
│  └─────────────────────────────────────────────────────────┘   │     (same visual, native component)
└─────────────────────────────────────────────────────────────────┘
```

### Progress Ring Migration (Sidebar loading)

**Before (Unicode spinner):**

```
┌─────────────────────────────────────────────────────────────────┐
│  PROJECTS                ⟳                                      │
│                     (Unicode spinner                            │
│                      with CSS rotation)                         │
└─────────────────────────────────────────────────────────────────┘
```

**After (vscode-progress-ring):**

```
┌─────────────────────────────────────────────────────────────────┐
│  PROJECTS                ◐                                      │
│                     <vscode-progress-ring>                      │
│                     (compact spinner)                           │
└─────────────────────────────────────────────────────────────────┘
```

### Sidebar Structure Migration

**Before (custom CSS borders and buttons):**

```
┌─────────────────────────────────────────────────────────────────┐
│  PROJECTS                                                       │
├─────────────────────────────────────────────────────────────────┤
│  my-project                               [+] [×]               │
│    ├── feature-auth                          [×]                │
│    └── bugfix-login                          [×]                │
│─────────────────────────────────────────────────────────────────│ ← CSS border
│  other-project                            [+] [×]               │
│    └── main                                  [×]                │
├─────────────────────────────────────────────────────────────────┤
│  [ Open Project ]                                               │
└─────────────────────────────────────────────────────────────────┘
```

**After (vscode-elements):**

```
┌─────────────────────────────────────────────────────────────────┐
│  PROJECTS                                                       │
├─────────────────────────────────────────────────────────────────┤
│  my-project              <vscode-toolbar>[+][×]</vscode-toolbar>│
│    ├── feature-auth                          [×]                │
│    └── bugfix-login                          [×]                │
│  <vscode-divider />                                             │ ← vscode-divider
│  other-project           <vscode-toolbar>[+][×]</vscode-toolbar>│
│    └── main                                  [×]                │
├─────────────────────────────────────────────────────────────────┤
│  <vscode-button>Open Project</vscode-button>                    │
└─────────────────────────────────────────────────────────────────┘
```

### Shortcut Mode Badges

**Before (custom styled spans in Sidebar):**

```
┌─────────────────────────────────────────────────────────────────┐
│  my-project                                                     │
│    ├── [1] feature-auth                                         │ ← .shortcut-index span
│    └── [2] bugfix-login                                         │
│                                                                 │
│  [O] Open Project                                               │
└─────────────────────────────────────────────────────────────────┘
```

**After (vscode-badge):**

```
┌─────────────────────────────────────────────────────────────────┐
│  my-project                                                     │
│    ├── <vscode-badge>1</vscode-badge> feature-auth              │
│    └── <vscode-badge>2</vscode-badge> bugfix-login              │
│                                                                 │
│  <vscode-badge>O</vscode-badge> Open Project                    │
└─────────────────────────────────────────────────────────────────┘
```

### ShortcutOverlay Badges

**Before (custom styled spans):**

```
┌─────────────────────────────────────────────────────────────────┐
│      ↑↓ Navigate    ⏎ New    ⌫ Del    1-0 Jump    O Open       │
│      (plain spans with custom CSS)                              │
└─────────────────────────────────────────────────────────────────┘
```

**After (vscode-badge for keys):**

```
┌─────────────────────────────────────────────────────────────────┐
│  <vscode-badge>↑↓</vscode-badge> Navigate                       │
│  <vscode-badge>⏎</vscode-badge> New                             │
│  <vscode-badge>⌫</vscode-badge> Del                             │
│  <vscode-badge>1-0</vscode-badge> Jump                          │
│  <vscode-badge>O</vscode-badge> Open                            │
└─────────────────────────────────────────────────────────────────┘
```

### Form Field Migration

**Before (native input + custom error):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Name                                                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ -invalid                                                 │   │  ← <input> with red border
│  └─────────────────────────────────────────────────────────┘   │
│  ⚠ Must start with letter or number                           │  ← <span class="error">
└─────────────────────────────────────────────────────────────────┘
```

**After (vscode-textfield + vscode-form-helper):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Name                                                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ -invalid                                                 │   │  ← <vscode-textfield>
│  └─────────────────────────────────────────────────────────┘   │
│  ⚠ Must start with letter or number                           │  ← <vscode-form-helper type="error">
└─────────────────────────────────────────────────────────────────┘
```

### User Interactions

**Web Component Event Pattern in Svelte:**

Web components don't support Svelte's `bind:value`. Use explicit property setting + event listening:

```svelte
<!-- Buttons: standard onclick works -->
<vscode-button onclick={handleClick}>Click me</vscode-button>

<!-- Textfield: set value property, listen to vsc-input event -->
<vscode-textfield value={myValue} on:vsc-input={(e) => (myValue = e.target.value)} />

<!-- Checkbox: set checked property, listen to vsc-change event -->
<vscode-checkbox checked={isChecked} on:vsc-change={(e) => (isChecked = e.detail.checked)} />
```

**Focus Management for Dialogs:**

```svelte
<script>
  let textfieldRef: HTMLElement;

  $effect(() => {
    if (open && textfieldRef) {
      textfieldRef.focus();
    }
  });
</script>

<vscode-textfield bind:this={textfieldRef} />
```

## Implementation Steps

**Note:** Phases must be executed in order. Later phases depend on earlier migrations being complete.

### Phase 1: Foundation Setup & Documentation

- [x] **Step 1.1: Update AGENTS.md with vscode-elements patterns**
  - Add new section "VSCode Elements Patterns" FIRST (source of truth for implementation)
  - Document component usage, event handling, and exceptions
  - Include the web component event pattern (on:vsc-input, not onvsc-input)
  - Include the property/event binding pattern (no bind:value for web components)
  - Include focus management pattern for dialogs
  - Files affected: `AGENTS.md`
  - Test criteria: Clear guidance on vscode-elements usage patterns

- [x] **Step 1.2: Create vscode-elements setup module**
  - Create `src/renderer/lib/vscode-elements-setup.ts` with bundled import
  - Import this module from `main.ts` (isolates third-party side effects)
  - Files affected: `src/renderer/lib/vscode-elements-setup.ts` (new), `src/renderer/main.ts`
  - Test criteria: Application loads without errors; `customElements.get('vscode-button')` returns a constructor

- [x] **Step 1.3: Verify TypeScript/Svelte accepts vscode-elements**
  - Test using `<vscode-button>` in a Svelte file
  - If type errors occur, add declarations to `svelteHTML.IntrinsicElements` in a new `vscode-elements.d.ts`
  - If no errors, skip creating declarations
  - Files affected: Potentially `src/renderer/vscode-elements.d.ts` (new, only if needed)
  - Test criteria: No TypeScript errors when using vscode-element tags in Svelte files

- [x] **Step 1.4: Add CSS variable fallbacks for standalone mode**
  - Add `--vscode-*` variable definitions at `:root` in `variables.css` that mirror `--ch-*` values
  - This ensures vscode-elements render correctly in standalone development mode
  - Files affected: `src/renderer/lib/styles/variables.css`
  - Test criteria: vscode-elements render correctly both in code-server context and standalone

- [x] **Step 1.5: Establish web component testing patterns**
  - Import bundled.js in test setup file (`src/test/setup.ts`)
  - Create a minimal test component using vscode-button with event handler
  - Verify Testing Library can query vscode-elements components
  - Document findings for reference
  - Files affected: `src/test/setup.ts`, potentially new test utility file
  - Test criteria: Tests can render and interact with vscode-elements

### Phase 2: Progress Indicators Migration (Simple, No Events)

Start with simpler components that have no event handling to validate setup.

- [x] **Step 2.1: Migrate SetupScreen progress bar**
  - Replace custom indeterminate progress bar with `<vscode-progress-bar indeterminate>`
  - Remove progress bar CSS and animation in same step
  - Files affected: `src/renderer/lib/components/SetupScreen.svelte`
  - Test criteria: Progress bar displays with indeterminate animation
  - CSS verification: Verify progress bar renders with VS Code styling after CSS removal

- [x] **Step 2.2: Migrate Sidebar loading spinner**
  - Replace Unicode spinner with `<vscode-progress-ring>`
  - Remove spinner rotation CSS in same step
  - Files affected: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Loading indicator displays during workspace loading; compact size appropriate for header
  - CSS verification: Verify progress ring renders correctly after CSS removal

### Phase 3: Button Migration

- [x] **Step 3.1: Migrate SetupError buttons**
  - Replace native buttons with `<vscode-button>` and `<vscode-button secondary>`
  - Remove button--primary/secondary CSS in same step
  - Files affected: `src/renderer/lib/components/SetupError.svelte`
  - Test criteria: Retry/Quit buttons render correctly; click handlers work; keyboard accessible
  - CSS verification: Verify buttons render with VS Code styling after CSS removal

- [x] **Step 3.2: Migrate CreateWorkspaceDialog buttons**
  - Replace OK/Cancel buttons with `<vscode-button>` and `<vscode-button secondary>`
  - Remove ok-button/cancel-button CSS in same step
  - Files affected: `src/renderer/lib/components/CreateWorkspaceDialog.svelte`
  - Test criteria: Dialog buttons render correctly; form submission works; disabled state works
  - CSS verification: Verify buttons render correctly after CSS removal

- [x] **Step 3.3: Migrate RemoveWorkspaceDialog buttons**
  - Replace Remove/Cancel buttons with `<vscode-button>` and `<vscode-button secondary>`
  - Remove button CSS in same step
  - Files affected: `src/renderer/lib/components/RemoveWorkspaceDialog.svelte`
  - Test criteria: Dialog buttons render correctly; remove action works
  - CSS verification: Verify buttons render correctly after CSS removal

- [x] **Step 3.4: Migrate Sidebar Open Project button**
  - Replace Open Project button with `<vscode-button>`
  - Remove .open-project-btn CSS in same step
  - Files affected: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Open Project button renders correctly; click handler works
  - CSS verification: Verify button renders correctly after CSS removal

### Phase 4: Sidebar Structure Migration

- [x] **Step 4.1: Research vscode-toolbar and icon button behavior**
  - **Finding**: vscode-elements has `vscode-toolbar-container` and `vscode-toolbar-button` components
  - **Decision**: Keep custom button grouping for project actions because:
    1. Current hover-reveal pattern works well with existing CSS
    2. vscode-toolbar-container would require CSS overrides to support hover-reveal
    3. Icon buttons (+, ×) are simple enough to keep as native buttons
  - **Note**: Step 4.3 will keep native buttons for project actions per this finding
  - Verify vscode-toolbar doesn't conflict with hover-reveal (may need CSS override)
  - Document icon button syntax (e.g., `<vscode-button icon>+</vscode-button>` or similar)
  - If toolbar conflicts, document workaround or keep custom button grouping
  - Files affected: None (research only)
  - Test criteria: Clear documentation of toolbar/icon button API and any limitations

- [x] **Step 4.2: Add vscode-divider between projects**
  - Replace CSS border-bottom with vscode-divider
  - Use pattern: `{#if projectIndex > 0}<vscode-divider />{/if}` before each project
  - Remove .project-item border-bottom CSS in same step
  - Files affected: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Dividers appear between projects (not before first, not after last)
  - CSS verification: Verify dividers render correctly after CSS removal

- [x] **Step 4.3: Migrate project action buttons to vscode-toolbar**
  - **Decision per Step 4.1**: Keeping native buttons for project action buttons
  - Reason: Hover-reveal pattern works well with current CSS; vscode-toolbar would require overrides
  - Wrap [+] and [×] project buttons in vscode-toolbar (if research shows compatibility)
  - Replace native buttons with vscode-button icon variant
  - If toolbar conflicts with hover-reveal, keep custom grouping but use vscode-button
  - Remove .action-btn and .project-actions CSS in same step
  - Files affected: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Toolbar groups buttons correctly; hover reveal still works; icon buttons display correctly
  - CSS verification: Verify action buttons render correctly after CSS removal

- [x] **Step 4.4: Migrate workspace remove button**
  - **Decision per Step 4.1**: Keeping native buttons for workspace remove button
  - Reason: Same hover-reveal pattern as project actions; consistency with Step 4.3
  - Replace workspace [×] button with vscode-button icon variant
  - Remove .remove-btn CSS in same step
  - Files affected: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Remove button renders as icon; hover reveal works
  - CSS verification: Verify remove button renders correctly after CSS removal

### Phase 5: Badge Migration

- [x] **Step 5.1: Migrate Sidebar shortcut indices to vscode-badge**
  - Replace .shortcut-index spans with `<vscode-badge>`
  - For dimmed state (indices > 9): add custom CSS class `.badge-dimmed { opacity: 0.4; }` (exception: vscode-badge has no built-in dimmed state)
  - Remove .shortcut-index and .shortcut-index--dimmed CSS in same step
  - Files affected: `src/renderer/lib/components/Sidebar.svelte`
  - Test criteria: Badges display 1-9, 0, O correctly; dimmed state for unavailable shortcuts
  - CSS verification: Verify badges render correctly (except documented dimmed exception)

- [x] **Step 5.2: Migrate ShortcutOverlay hints to vscode-badge**
  - Replace key hints with `<vscode-badge>` for ↑↓, ⏎, ⌫, 1-0, O
  - Keep action text as plain text next to badge
  - Remove .shortcut-hint CSS in same step
  - Files affected: `src/renderer/lib/components/ShortcutOverlay.svelte`
  - Test criteria: Badges render with VS Code styling; hidden state still works
  - CSS verification: Verify badges render correctly after CSS removal

### Phase 6: Form Controls Migration

- [x] **Step 6.1: Migrate CreateWorkspaceDialog text input**
  - Replace native input with `<vscode-textfield>`
  - Use property/event pattern: `value={name} on:vsc-input={(e) => name = e.target.value}`
  - Add focus management: `$effect` to focus textfield when dialog opens
  - Replace error span with `<vscode-form-helper type="error">`
  - Remove duplicated input CSS and error CSS in same step
  - Files affected: `src/renderer/lib/components/CreateWorkspaceDialog.svelte`
  - Test criteria: Input accepts text; validation styling works; error messages display; initial focus works
  - CSS verification: Verify input and error render correctly after CSS removal

- [x] **Step 6.2: Migrate RemoveWorkspaceDialog checkbox**
  - Replace native checkbox with `<vscode-checkbox>`
  - Use property/event pattern: `checked={deleteBranch} on:vsc-change={(e) => deleteBranch = e.detail.checked}`
  - Remove .checkbox-label CSS in same step
  - Files affected: `src/renderer/lib/components/RemoveWorkspaceDialog.svelte`
  - Test criteria: Checkbox toggles; checked state persists; label clickable
  - CSS verification: Verify checkbox renders correctly after CSS removal

### Phase 7: Final Cleanup

- [x] **Step 7.1: Fix screen reader text inconsistency**
  - Replace `.sr-only` in App.svelte with `.ch-visually-hidden`
  - Files affected: `src/renderer/App.svelte`
  - Test criteria: Screen reader text hidden visually but accessible

- [x] **Step 7.2: Audit and remove remaining --ch-button-\* variables (if unused)**
  - Audited: `--ch-button-bg`, `--ch-button-fg`, `--ch-button-hover-bg` are defined but not used by any component
  - Decision: Keep variables - they're documented in AGENTS.md and provide VS Code fallbacks for potential future custom buttons
  - vscode-button handles its own styling using --vscode-button-\* variables directly
  - Files affected: None (keeping as-is)
  - Test criteria: Variables remain for documentation consistency

### Phase 8: Documentation Finalization

- [x] **Step 8.1: Update USER_INTERFACE.md**
  - Correct the statement that vscode-elements is implemented (it now actually is!)
  - Add section documenting which vscode-elements are used where
  - Document the BranchDropdown exception
  - Files affected: `docs/USER_INTERFACE.md`
  - Test criteria: Documentation accurately reflects current implementation

- [x] **Step 8.2: Update variables.css documentation comment**
  - Add note explaining --vscode-\* fallbacks for vscode-elements compatibility
  - Files affected: `src/renderer/lib/styles/variables.css`
  - Test criteria: Clear explanation of variable relationship

### Phase 9: Review Agent Update

- [x] **Step 9.1: Update review-ui agent to check for vscode-elements usage**
  - Add vscode-elements review criteria to review-ui agent prompt
  - Agent must check for native HTML that should use vscode-elements
  - Agent must verify exceptions are documented (e.g., BranchDropdown)
  - Agent must verify correct event syntax (`on:vsc-input` not `onvsc-input`)
  - Files affected: `.opencode/agent/review-ui.md`
  - Test criteria: review-ui agent flags native HTML elements that should use vscode-elements

## Testing Strategy

### Unit Tests (vitest)

| Test Case                    | Description                       | File                            |
| ---------------------------- | --------------------------------- | ------------------------------- |
| vscode-button renders        | Button component mounts correctly | `SetupError.test.ts`            |
| vscode-button click          | Click handler fires               | `SetupError.test.ts`            |
| vscode-button disabled       | Disabled state prevents clicks    | `CreateWorkspaceDialog.test.ts` |
| vscode-textfield value       | Property/event binding works      | `CreateWorkspaceDialog.test.ts` |
| vscode-textfield validation  | Invalid state shows correctly     | `CreateWorkspaceDialog.test.ts` |
| vscode-textfield focus       | Initial focus on dialog open      | `CreateWorkspaceDialog.test.ts` |
| vscode-checkbox toggle       | Checked state changes via event   | `RemoveWorkspaceDialog.test.ts` |
| vscode-progress-bar renders  | Progress bar visible              | `SetupScreen.test.ts`           |
| vscode-progress-ring renders | Progress ring visible             | `Sidebar.test.ts`               |
| vscode-badge renders         | Badge displays content            | `Sidebar.test.ts`               |
| vscode-badge dimmed          | Custom dimmed class applies       | `Sidebar.test.ts`               |
| vscode-toolbar renders       | Toolbar groups buttons            | `Sidebar.test.ts`               |
| vscode-divider renders       | Divider visible between projects  | `Sidebar.test.ts`               |

### Integration Tests

| Test Case                | Description                           | File                            |
| ------------------------ | ------------------------------------- | ------------------------------- |
| Dialog form submission   | Full dialog flow with vscode-elements | `CreateWorkspaceDialog.test.ts` |
| Dialog keyboard nav      | Tab through vscode-elements           | `Dialog.test.ts`                |
| Setup flow complete      | Progress bar shows during setup       | `integration.test.ts`           |
| Shortcut mode overlay    | Badges appear/hide correctly          | `ShortcutOverlay.test.ts`       |
| Sidebar shortcut indices | Badges show during shortcut mode      | `Sidebar.test.ts`               |

### Manual Testing Checklist

- [ ] SetupScreen: Progress bar animates smoothly with indeterminate state
- [ ] SetupError: Retry and Quit buttons are keyboard accessible
- [ ] CreateWorkspaceDialog: Tab through Name field, Branch dropdown, Cancel, OK
- [ ] CreateWorkspaceDialog: Name field receives focus when dialog opens
- [ ] CreateWorkspaceDialog: Error message appears with red styling when invalid
- [ ] RemoveWorkspaceDialog: Checkbox toggles with click and keyboard
- [ ] RemoveWorkspaceDialog: "Delete branch" checkbox label is clickable
- [ ] Sidebar: Dividers appear between projects (not after last project)
- [ ] Sidebar: Toolbar actions [+][×] appear on project hover
- [ ] Sidebar: Loading ring appears while fetching projects
- [ ] Sidebar: Shortcut badges (1-9, 0, O) appear in shortcut mode
- [ ] Sidebar: Badge for index > 9 is dimmed
- [ ] ShortcutOverlay: Badges render with VS Code styling
- [ ] ShortcutOverlay: Unavailable shortcuts are hidden
- [ ] All buttons: Focus ring visible on keyboard focus
- [ ] Light theme: All vscode-elements render correctly
- [ ] Dark theme: All vscode-elements render correctly
- [ ] **Accessibility**: Screen reader announces form fields correctly
- [ ] **Accessibility**: Screen reader announces button labels correctly
- [ ] **Accessibility**: Keyboard navigation works through all interactive elements

## Dependencies

| Package                   | Purpose                    | Approved         |
| ------------------------- | -------------------------- | ---------------- |
| @vscode-elements/elements | Already installed (v2.3.1) | [x] Pre-existing |

**No new dependencies required.**

## Documentation Updates

### Files to Update

| File                                  | Changes Required                                                       |
| ------------------------------------- | ---------------------------------------------------------------------- |
| AGENTS.md                             | Add "VSCode Elements Patterns" section with usage guidelines (Phase 1) |
| docs/USER_INTERFACE.md                | Correct implementation status; add vscode-elements component mapping   |
| src/renderer/lib/styles/variables.css | Add --vscode-\* fallbacks and documentation comment                    |
| .opencode/agent/review-ui.md          | Add vscode-elements review criteria                                    |

### New Files

| File                                      | Purpose                                  |
| ----------------------------------------- | ---------------------------------------- |
| src/renderer/lib/vscode-elements-setup.ts | Isolated vscode-elements import          |
| src/renderer/vscode-elements.d.ts         | TypeScript declarations (only if needed) |

### AGENTS.md Addition (Draft)

````markdown
## VSCode Elements Patterns

### Component Usage

All UI components MUST use `@vscode-elements/elements` instead of native HTML where a vscode-element equivalent exists:

| Native HTML               | Use Instead              | When to Keep Native                                     |
| ------------------------- | ------------------------ | ------------------------------------------------------- |
| `<button>`                | `<vscode-button>`        | Never - always use vscode-button                        |
| `<input type="text">`     | `<vscode-textfield>`     | Complex custom controls (e.g., combobox with filtering) |
| `<input type="checkbox">` | `<vscode-checkbox>`      | Never - always use vscode-checkbox                      |
| `<select>`                | `<vscode-single-select>` | Custom dropdowns with filtering/grouping                |
| `<textarea>`              | `<vscode-textarea>`      | Never - always use vscode-textarea                      |
| Custom spinner            | `<vscode-progress-ring>` | Never - always use progress-ring                        |
| Custom progress bar       | `<vscode-progress-bar>`  | Complex custom visualizations                           |
| CSS border separator      | `<vscode-divider>`       | When semantic divider not appropriate                   |
| Button groups             | `<vscode-toolbar>`       | Non-linear layouts or hover-reveal conflicts            |
| Indicator/label           | `<vscode-badge>`         | Complex styled indicators                               |

### Event Handling in Svelte

**IMPORTANT**: Web components emit CustomEvents. Use Svelte's `on:` syntax, NOT `oneventname`:

```svelte
<!-- CORRECT: Use on: prefix for custom events -->
<vscode-button onclick={handleClick}>Click me</vscode-button>
<vscode-textfield
  value={myValue}
  on:vsc-input={(e) => myValue = e.target.value}
/>
<vscode-checkbox
  checked={isChecked}
  on:vsc-change={(e) => isChecked = e.detail.checked}
/>

<!-- WRONG: This won't work for custom events -->
<vscode-textfield onvsc-input={(e) => ...} />
```
````

### Property Binding

Web components don't support Svelte's `bind:value`. Use explicit property + event:

```svelte
<!-- WRONG: bind:value doesn't work with web components -->
<vscode-textfield bind:value={name} />

<!-- CORRECT: Set property and listen to event -->
<vscode-textfield value={name} on:vsc-input={(e) => (name = e.target.value)} />
```

### Focus Management

For dialogs that need initial focus on a vscode-element:

```svelte
<script>
  let textfieldRef: HTMLElement;

  $effect(() => {
    if (open && textfieldRef) {
      textfieldRef.focus();
    }
  });
</script>

<vscode-textfield bind:this={textfieldRef} value={name} on:vsc-input={...} />
```

### Exceptions

The following components intentionally use native HTML:

1. **BranchDropdown**: Uses native `<input>` + custom dropdown for filtering and grouped options (Local/Remote branches). `vscode-single-select` doesn't support these features.

### Known Limitations

1. **vscode-badge**: No built-in dimmed state. Use custom CSS: `.badge-dimmed { opacity: 0.4; }`
2. **vscode-toolbar**: May conflict with hover-reveal patterns. Test and use custom grouping if needed.

### Importing

vscode-elements are imported once via a setup module:

```typescript
// src/renderer/lib/vscode-elements-setup.ts
import "@vscode-elements/elements/dist/bundled.js";

// src/renderer/main.ts
import "./lib/vscode-elements-setup.ts";
```

Components are then available globally as custom elements.

```

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (AGENTS.md, USER_INTERFACE.md, variables.css)
- [ ] review-ui agent updated to check for vscode-elements usage
- [ ] Accessibility regression testing passed (keyboard nav, screen reader)
- [ ] User acceptance testing passed
- [ ] Changes committed
```
