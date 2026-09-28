---
status: COMPLETED
last_updated: 2025-12-14
reviewers: [review-ui, review-typescript, review-arch, review-testing, review-docs]
---

# CREATE_WORKSPACE_PROJECT_SELECTION

## Overview

- **Problem**: When creating a workspace, the project is predetermined by context. Users can't easily create a workspace in a different project without navigating to that project first.
- **Solution**: Add a project dropdown selector to the CreateWorkspaceDialog that defaults to the current workspace's project but allows selecting any open project.
- **Risks**:
  - Focus management complexity (project dropdown vs name input)
  - Branch dropdown needs to refresh when project changes
  - Refactoring BranchDropdown to use shared component may introduce regressions
  - Grouping logic in BranchDropdown affects keyboard navigation indices
- **Alternatives Considered**:
  - Separate "Create in Project..." menu item → Rejected: adds UI complexity, fragments workflow
  - Radio buttons for project selection → Rejected: doesn't scale with many projects
  - Duplicate dropdown logic in ProjectDropdown → Rejected: violates DRY, harder to maintain
  - Extract only utilities instead of full component → Acceptable but full component provides better consistency

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FilterableDropdown                            │
│  (shared component - "wrapper component" pattern)                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ • Native <input> element (documented exception for filtering)│    │
│  │ • Keyboard navigation (↑↓, Enter, Escape, Tab)              │    │
│  │ • Fixed positioning (per AGENTS.md pattern)                  │    │
│  │ • Highlight state management                                 │    │
│  │ • Mousedown selection pattern                                │    │
│  │ • Debounced filtering (200ms default)                        │    │
│  │ • Snippet slot for custom option rendering                   │    │
│  │ • ARIA combobox accessibility pattern                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                    │                           │
                    ▼                           ▼
     ┌──────────────────────────────────────┐   ┌──────────────────────────┐
     │     BranchDropdown                   │   │    ProjectDropdown       │
     │  ┌────────────────────────────────┐  │   │  ┌────────────────────┐  │
     │  │ • Async loading via listBases()│  │   │  │ • Sync from store  │  │
     │  │ • Transforms to DropdownOption │  │   │  │ • Flat list        │  │
     │  │ • Group headers as non-select- │  │   │  │ • Name display,    │  │
     │  │   able options (type: 'header')│  │   │  │   path as value    │  │
     │  │ • Custom snippet for rendering │  │   │  └────────────────────┘  │
     │  └────────────────────────────────┘  │   └──────────────────────────┘
     └──────────────────────────────────────┘
```

**Grouping Strategy for BranchDropdown**:

```typescript
// BranchDropdown transforms branches into a mixed array:
type DropdownOption =
  | { type: "header"; label: string; value: string } // Non-selectable
  | { type: "option"; label: string; value: string }; // Selectable

// Example transformation:
[
  { type: "header", label: "Local Branches", value: "__header_local__" },
  { type: "option", label: "main", value: "main" },
  { type: "option", label: "feature-x", value: "feature-x" },
  { type: "header", label: "Remote Branches", value: "__header_remote__" },
  { type: "option", label: "origin/main", value: "origin/main" },
];

// FilterableDropdown skips headers in keyboard navigation
// optionSnippet renders headers differently (non-interactive styling)
```

**CreateWorkspaceDialog Data Flow**:

```
activeProject.value ──► selectedProject (initial default)
                              │
                              ▼
               projects.value ◄── ProjectDropdown reads
                              │
                              ▼
              BranchDropdown ◄── refreshes on project change
                              │
                              ▼
              existingNames ◄── validates against selected project
                              │
                              ▼
              nameError ◄── re-validates when project changes (if touched)
```

## UI Design

```
┌─────────────────────────────────────────┐
│ Create Workspace                      X │
├─────────────────────────────────────────┤
│                                         │
│ Project                                 │
│ ┌─────────────────────────────────────┐ │
│ │ my-project                        ▼ │ │
│ └─────────────────────────────────────┘ │
│   ┌───────────────────────────────────┐ │
│   │ my-project        ← selected      │ │
│   │ other-project                     │ │
│   │ another-project                   │ │
│   └───────────────────────────────────┘ │
│                                         │
│ Name                                    │
│ ┌─────────────────────────────────────┐ │
│ │                          (focused)  │ │  ← Initial focus here
│ └─────────────────────────────────────┘ │
│                                         │
│ Base Branch                             │
│ ┌─────────────────────────────────────┐ │
│ │ Select branch...                  ▼ │ │
│ └─────────────────────────────────────┘ │
│                                         │
│              [Create] [Cancel]          │
└─────────────────────────────────────────┘
```

### User Interactions

- **DOM/Tab order**: Project → Name → Branch → Create → Cancel
- **Initial focus**: Name input (programmatically set via `$effect` after dialog opens)
  - Users can Shift+Tab backward to Project, or Tab forward to Branch
- **Project change**: Clears branch selection, refreshes branch list, re-validates name if touched
- **Focus after project selection**: Stays on ProjectDropdown (user can Tab to next field)
- **Keyboard** (both dropdowns):
  - Arrow Up/Down: Navigate selectable options (skip headers)
  - Enter: Select highlighted option
  - Escape: Close dropdown without selecting
  - Tab: Select highlighted option (or exact text match if no navigation) and move focus

### ARIA Accessibility Pattern

FilterableDropdown implements the combobox pattern:

- Input: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`, `aria-haspopup="listbox"`
- Listbox: `role="listbox"`, unique `id` for aria-controls
- Options: `role="option"`, `aria-selected`, unique `id` for aria-activedescendant
- Headers: `role="presentation"` (not navigable)

## Implementation Steps

### - [x] Step 1: Create FilterableDropdown shared component (TDD)

**1a. Write failing tests** (`src/renderer/lib/components/FilterableDropdown.test.ts`):

| Test Case                                  | Description                                |
| ------------------------------------------ | ------------------------------------------ |
| renders all options                        | Shows all provided options in dropdown     |
| filters options using callback             | Typing filters list via filterOption       |
| empty filter shows all options             | No filter text displays complete list      |
| debounces filter input                     | Filter applies after 200ms delay           |
| Arrow Down navigates to next option        | Keyboard navigation works                  |
| Arrow Up navigates to previous option      | Wraps at boundaries                        |
| Arrow Down skips header options            | Headers not navigable                      |
| Enter selects highlighted option           | Selection via keyboard                     |
| Tab selects highlighted option             | Tab commits selection                      |
| Tab selects exact match when no navigation | Typed text exact match                     |
| Escape closes dropdown                     | No selection on escape                     |
| calls onSelect with option value           | Callback receives correct value            |
| disabled prop prevents interaction         | No open, no keyboard                       |
| correct ARIA attributes set                | role, aria-expanded, aria-activedescendant |
| position recalculates on window resize     | Fixed positioning updates                  |
| optionSnippet renders custom content       | Snippet prop works                         |
| handles options prop change while open     | Dynamic options supported                  |

**1b. Implement FilterableDropdown** (`src/renderer/lib/components/FilterableDropdown.svelte`):

```typescript
import type { Snippet } from "svelte";

// Use string-based value selection (simpler than full generics)
// Wrapper components handle domain-specific typing
interface DropdownOption {
  type: "option" | "header";
  label: string;
  value: string;
}

interface FilterableDropdownProps {
  options: DropdownOption[];
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  filterOption: (option: DropdownOption, filterLowercase: string) => boolean;
  id?: string;
  debounceMs?: number; // Default: 200
  optionSnippet?: Snippet<[option: DropdownOption, highlighted: boolean]>;
}
```

Implementation requirements:

- Use native `<input type="text">` (documented exception for filtering)
- Use Fixed Positioning pattern from AGENTS.md (`getBoundingClientRect()`, `position: fixed`)
- Internal state with Svelte 5 runes:
  ```typescript
  let isOpen = $state(false);
  let highlightedIndex = $state(-1);
  let filterText = $state("");
  let debouncedFilter = $state("");
  const selectableOptions = $derived(options.filter((opt) => opt.type === "option"));
  const filteredOptions = $derived.by(() =>
    debouncedFilter === ""
      ? options
      : options.filter((opt) => filterOption(opt, debouncedFilter.toLowerCase()))
  );
  ```
- Keyboard navigation skips `type: 'header'` options
- Effect cleanup for debounce timer and resize listener
- Safe array access (no non-null assertions):
  ```typescript
  const highlightedOption = selectableOptions[highlightedIndex];
  if (highlightedOption !== undefined) {
    selectOption(highlightedOption.value);
  }
  ```

**1c. Refactor** if needed while keeping tests green.

---

### - [x] Step 2: Refactor BranchDropdown to use FilterableDropdown (TDD)

**2a. Run existing BranchDropdown tests - establish baseline**:

- Verify all existing tests pass before refactoring
- Document current test count and coverage

**2b. Write additional tests for wrapper behavior**:

| Test Case                                   | Description                   | File                     |
| ------------------------------------------- | ----------------------------- | ------------------------ |
| transforms branches to DropdownOption[]     | Correct data structure        | `BranchDropdown.test.ts` |
| adds Local Branches header                  | Header before local branches  | `BranchDropdown.test.ts` |
| adds Remote Branches header                 | Header before remote branches | `BranchDropdown.test.ts` |
| headers render with non-interactive styling | Visual distinction            | `BranchDropdown.test.ts` |
| async loading shows loading state           | Before FilterableDropdown     | `BranchDropdown.test.ts` |
| error state displays error message          | API failure handling          | `BranchDropdown.test.ts` |

**Integration test** (`BranchDropdown.test.ts`):

| Test Case                                       | Description                       |
| ----------------------------------------------- | --------------------------------- |
| BranchDropdown + FilterableDropdown integration | Async load → filter → select flow |

**2c. Refactor BranchDropdown**:

- Keep as wrapper component
- Transform `BaseInfo[]` to `DropdownOption[]` with headers
- Handle async loading and error states in wrapper (before rendering FilterableDropdown)
- Pass custom `optionSnippet` for header vs. branch rendering
- Maintain all existing public API and behavior

**2d. Verify all baseline tests still pass** (regression check).

---

### - [x] Step 3: Create ProjectDropdown using FilterableDropdown (TDD)

**3a. Write failing tests** (`src/renderer/lib/components/ProjectDropdown.test.ts`):

| Test Case                                | Description               |
| ---------------------------------------- | ------------------------- |
| renders all open projects                | Shows projects from store |
| displays project name as label           | User sees name            |
| onSelect returns project path (not name) | Value is path             |
| filters projects by name                 | Typing filters list       |
| keyboard navigation works                | Arrow/Enter/Escape        |
| handles very long project names          | No layout break           |

**3b. Implement ProjectDropdown** (`src/renderer/lib/components/ProjectDropdown.svelte`):

- Read projects from `projects.value` store
- Transform to `DropdownOption[]` (all `type: 'option'`, no headers)
- Display project name, store project path as value
- Simple flat list

**3c. Refactor** if needed.

---

### - [x] Step 4: Update CreateWorkspaceDialog to use ProjectDropdown (TDD)

**4a. Write failing tests** (`src/renderer/lib/components/CreateWorkspaceDialog.test.ts`):

| Test Case                                       | Description              |
| ----------------------------------------------- | ------------------------ |
| renders project dropdown above name input       | DOM order correct        |
| project dropdown shows projectPath prop value   | Default selection        |
| name input has initial focus (not project)      | Focus management         |
| form submits with selected project              | Uses selectedProject     |
| validation checks selected project's workspaces | Not prop project         |
| respects dialog focus trap                      | Tab cycles within dialog |

**4b. Implement changes**:

- Add `selectedProject` state with proper typing:
  ```typescript
  let selectedProject = $state<string>(projectPath);
  ```
- Add ProjectDropdown above name input in DOM
- Set initial focus on name input via `$effect`:
  ```typescript
  let nameInputRef: HTMLElement | undefined = $state();
  $effect(() => {
    if (open && nameInputRef) {
      nameInputRef.focus();
    }
  });
  ```
- Update `existingNames` derived to use `selectedProject`
- Update `createWorkspace()` call to use `selectedProject`

**4c. Refactor** if needed.

---

### - [x] Step 5: Reset branch and re-validate when project changes (TDD)

**5a. Write failing tests**:

| Test Case                                           | Description             | File                            |
| --------------------------------------------------- | ----------------------- | ------------------------------- |
| changing project clears branch selection            | Branch resets to ''     | `CreateWorkspaceDialog.test.ts` |
| branch dropdown shows new project's branches        | Refetch on change       | `CreateWorkspaceDialog.test.ts` |
| sequential project changes clear branch each time   | Multiple changes work   | `CreateWorkspaceDialog.test.ts` |
| name re-validates when project changes (if touched) | Duplicate check updates | `CreateWorkspaceDialog.test.ts` |

**5b. Implement**:

- Add `$effect` to watch `selectedProject` and clear `selectedBranch`:
  ```typescript
  let previousProject = projectPath;
  $effect(() => {
    if (selectedProject !== previousProject) {
      previousProject = selectedProject;
      selectedBranch = "";
      // Re-validate name if user has already interacted
      if (touched) {
        nameError = validateName(name);
      }
    }
  });
  ```
- Pass `selectedProject` to BranchDropdown (triggers refetch via its `$effect`)
- Focus stays on ProjectDropdown after selection (no auto-focus to branch)

**5c. Refactor** if needed.

---

### - [x] Step 6: Update dialog store for default project (TDD)

**6a. Write failing tests** (`src/renderer/lib/stores/dialogs.svelte.test.ts`):

| Test Case                                          | Description          |
| -------------------------------------------------- | -------------------- |
| openCreateDialog uses provided defaultProjectPath  | Explicit param works |
| openCreateDialog uses activeProject when no param  | Falls back to active |
| openCreateDialog uses first project when no active | Last resort fallback |

**6b. Implement**:

- Modify `openCreateDialog()` signature:
  ```typescript
  export function openCreateDialog(defaultProjectPath?: string): void {
    const projectPath =
      defaultProjectPath ?? activeProject.value?.path ?? projects.value[0]?.path ?? "";
    _dialogState = { type: "create", projectPath };
  }
  ```
- Import `activeProject` and `projects` from projects store

**6c. Refactor** if needed.

## Testing Strategy

### Unit Tests (vitest)

**FilterableDropdown** (`FilterableDropdown.test.ts`):

| Test Case                       | Description                |
| ------------------------------- | -------------------------- |
| renders all options             | Shows all provided options |
| filters options using callback  | Typing filters list        |
| empty filter shows all options  | Complete list when empty   |
| debounces filter input          | 200ms delay                |
| Arrow Down/Up navigation        | Keyboard nav works         |
| Arrow navigation skips headers  | Headers not navigable      |
| Enter selects highlighted       | Keyboard selection         |
| Tab selects highlighted         | Tab commits selection      |
| Tab selects exact match         | No navigation case         |
| Escape closes dropdown          | No selection               |
| calls onSelect with value       | Correct callback           |
| disabled prevents interaction   | No open/keyboard           |
| correct ARIA attributes         | Accessibility              |
| position recalculates on resize | Fixed positioning          |
| optionSnippet renders custom    | Snippet works              |

**BranchDropdown** (`BranchDropdown.test.ts`):

| Test Case                           | Description        |
| ----------------------------------- | ------------------ |
| transforms to DropdownOption[]      | Data structure     |
| adds Local/Remote headers           | Grouping           |
| headers non-interactive             | Visual distinction |
| async loading state                 | Before dropdown    |
| error state                         | API failure        |
| integration with FilterableDropdown | Full flow          |

**ProjectDropdown** (`ProjectDropdown.test.ts`):

| Test Case                   | Description     |
| --------------------------- | --------------- |
| renders all projects        | From store      |
| displays name, returns path | Value mapping   |
| filters by name             | Filtering works |
| keyboard navigation         | Arrow/Enter     |
| handles long names          | No layout break |

**CreateWorkspaceDialog** (`CreateWorkspaceDialog.test.ts`):

| Test Case                           | Description          |
| ----------------------------------- | -------------------- |
| project dropdown above name         | DOM order            |
| defaults to prop project            | Initial selection    |
| name has initial focus              | Not project dropdown |
| submits with selected project       | Form submission      |
| validates against selected project  | Duplicate check      |
| respects focus trap                 | Tab cycling          |
| clears branch on project change     | Reset behavior       |
| re-validates name on project change | If touched           |
| sequential project changes work     | Multiple changes     |

**Dialog Store** (`dialogs.svelte.test.ts`):

| Test Case                         | Description    |
| --------------------------------- | -------------- |
| uses provided defaultProjectPath  | Explicit param |
| uses activeProject when no param  | Fallback       |
| uses first project when no active | Last resort    |

### Integration Tests

| Test Case                                   | Description                                                                                     | File                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| Create workspace in different project       | Full flow: open → select project B → branch refreshes → select branch → create → workspace in B | `CreateWorkspaceDialog.test.ts` |
| Dialog opens with activeProject selected    | Store default + dialog rendering                                                                | `CreateWorkspaceDialog.test.ts` |
| BranchDropdown async load + filter + select | Full async flow                                                                                 | `BranchDropdown.test.ts`        |

### Manual Testing Checklist

- [ ] Open create dialog from workspace list - project dropdown shows current project
- [ ] Project dropdown lists all open projects
- [ ] Can filter projects by typing
- [ ] Selecting different project clears branch selection
- [ ] Branch dropdown loads branches for newly selected project
- [ ] Tab order: Project → Name → Branch → Create → Cancel
- [ ] Name input has focus when dialog opens (not project dropdown)
- [ ] Shift+Tab from Name moves to Project dropdown
- [ ] Create workspace in different project succeeds
- [ ] Escape closes project dropdown without closing dialog
- [ ] Branch dropdown still shows Local/Remote grouping (headers non-selectable)
- [ ] Both dropdowns handle empty filter (show all options)
- [ ] Keyboard navigation skips header rows in branch dropdown
- [ ] Name validation updates when project changes (shows duplicate error if name exists in new project)

## Dependencies

No new dependencies required. Uses existing patterns and Svelte 5 snippets for composition.

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs/USER_INTERFACE.md | Update "Creating a Workspace" section (~line 246-320): Add project dropdown to dialog mockup (before Name field). Update flow step 3: "Select target project (defaults to current workspace's project)". Note that uniqueness validates against selected project.                                                            |
| AGENTS.md              | Add to "UI Patterns" section: FilterableDropdown shared component pattern with snippet slots for custom option rendering. Document the "wrapper component" pattern (domain components like BranchDropdown wrap FilterableDropdown for data fetching/transformation). Note native `<input>` exception for combobox filtering. |

### New Documentation Required

None required.

## Definition of Done

- [ ] All implementation steps complete (TDD: tests written first)
- [ ] All existing BranchDropdown tests pass (no regressions)
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (USER_INTERFACE.md, AGENTS.md)
- [ ] User acceptance testing passed
- [ ] Changes committed
