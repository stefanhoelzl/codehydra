---
status: COMPLETED
last_updated: 2026-01-04
reviewers: [review-arch, review-quality, review-testing]
---

# VSCODE_OBJECT_SERIALIZATION

## Overview

- **Problem**: VS Code commands often require class instances (Uri, Position, Range, etc.) that cannot be serialized through JSON. When using CodeHydra's MCP `workspace_execute_command` tool or IPC interface, these objects lose their prototypes and methods, causing commands to fail silently or error.

- **Solution**: Introduce a convention where VS Code objects are wrapped with a `$vscode` type marker. A pure TypeScript reconstruction utility (in `src/shared/`) recognizes these markers and reconstructs the actual VS Code objects using injected factory functions. The sidekick extension wires in the real `vscode` constructors.

- **Risks**:
  - **Collision risk**: Using `$vscode` as a key could theoretically collide with legitimate data. Mitigation: `$vscode` is an unlikely key in normal usage. If a command genuinely needs to pass `{ "$vscode": "literal" }` as data, wrap it in another object: `{ "data": { "$vscode": "literal" } }`.
  - **Incomplete reconstruction**: Missing support for a VS Code object type. Mitigation: Start with the most common types, document supported types clearly, and provide clear error messages for unsupported types.
  - **Nested objects**: Deep nesting with mixed VS Code and plain objects. Mitigation: Recursive transformation handles arbitrary depth.
  - **Circular references**: Circular object references would cause infinite recursion. Mitigation: Not supported - will cause stack overflow. Document this limitation.

- **Alternatives Considered**:
  1. **Schema-based transformation**: Define which arguments need transformation per command. Rejected: Would require maintaining a database of all VS Code commands and their signatures.
  2. **MCP-side reconstruction**: Reconstruct objects in the MCP server. Rejected: The `vscode` module is only available in the extension context, not in the main process.
  3. **String-based DSL**: Use strings like `"Uri:file:///path"`. Rejected: Less flexible and harder to represent complex nested objects like Location (which contains both Uri and Range).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ AI Agent (Claude)                                                           │
│                                                                             │
│  vscode.open requires Uri, so I'll use:                                     │
│  { "$vscode": "Uri", "value": "file:///path/to/file.ts" }                   │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ MCP Server (workspace_execute_command)                                      │
│                                                                             │
│  args: [{ "$vscode": "Uri", "value": "file:///path/to/file.ts" }]          │
│                                                                             │
│  → Passes through as-is (JSON-serializable)                                 │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ Socket.IO
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Sidekick Extension                                                          │
│                                                                             │
│  import { reconstructVscodeObjects } from "shared/vscode-serialization";    │
│  import * as vscode from "vscode";                                          │
│                                                                             │
│  const factories = {                                                        │
│    Uri: (v) => vscode.Uri.parse(v.value),                                   │
│    Position: (v) => new vscode.Position(v.line, v.character),               │
│    // ...                                                                   │
│  };                                                                         │
│                                                                             │
│  socket.on("command", (request, ack) => {                                   │
│    const args = reconstructVscodeObjects(request.args ?? [], factories);    │
│    vscode.commands.executeCommand(request.command, ...args);                │
│  });                                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Supported VS Code Object Types

| Type      | `$vscode` Value | Required Fields     | Field Types            | Reconstruction                  |
| --------- | --------------- | ------------------- | ---------------------- | ------------------------------- |
| Uri       | `"Uri"`         | `value`             | `string`               | `Uri.parse(value)`              |
| Position  | `"Position"`    | `line`, `character` | `number`, `number`     | `new Position(line, character)` |
| Range     | `"Range"`       | `start`, `end`      | `Position`, `Position` | `new Range(start, end)`         |
| Selection | `"Selection"`   | `anchor`, `active`  | `Position`, `Position` | `new Selection(anchor, active)` |
| Location  | `"Location"`    | `uri`, `range`      | `Uri`, `Range`         | `new Location(uri, range)`      |

**Supported types constant**: `SUPPORTED_VSCODE_TYPES = new Set(["Uri", "Position", "Range", "Selection", "Location"])`

**Future additions**: `TextEdit` (requires Range + newText) may be added if needed for refactoring commands.

### JSON Format Examples

**Uri**:

```json
{ "$vscode": "Uri", "value": "file:///path/to/file.ts" }
```

**Position**:

```json
{ "$vscode": "Position", "line": 10, "character": 5 }
```

**Range**:

```json
{
  "$vscode": "Range",
  "start": { "$vscode": "Position", "line": 10, "character": 5 },
  "end": { "$vscode": "Position", "line": 10, "character": 20 }
}
```

**Location** (fully nested):

```json
{
  "$vscode": "Location",
  "uri": { "$vscode": "Uri", "value": "file:///path/to/file.ts" },
  "range": {
    "$vscode": "Range",
    "start": { "$vscode": "Position", "line": 10, "character": 5 },
    "end": { "$vscode": "Position", "line": 10, "character": 20 }
  }
}
```

### Nested Object Handling

The reconstruction is recursive, processing:

- Arrays: each element is recursively processed
- Objects: each property value is recursively processed
- `$vscode` markers: validated and reconstructed using factory functions

Plain objects and primitives pass through unchanged. Mixed objects work correctly:

```json
{
  "label": "Go to definition",
  "location": { "$vscode": "Location", "uri": {...}, "range": {...} }
}
```

Result: `{ label: "Go to definition", location: <Location instance> }`

### Error Handling

**Unknown type error format**:

```
Unknown VS Code object type: "Unknown". Supported types: Uri, Position, Range, Selection, Location
```

**Missing field error format**:

```
Invalid VS Code Position: missing required field "line"
```

**Invalid field type error format**:

```
Invalid VS Code Position: field "line" must be a number, got string
```

## Implementation Steps

- [x] **Step 1: Create VS Code object reconstruction utility**
  - Create `src/shared/vscode-serialization.ts` with:
    - `SUPPORTED_VSCODE_TYPES` constant (Set of type names)
    - `VscodeWrapper` discriminated union type
    - `VscodeFactories` interface for factory function injection
    - `reconstructVscodeObjects(value: unknown, factories: VscodeFactories): unknown` function
  - Implement type-safe validation for each object type's required fields
  - Handle recursive transformation for nested objects and arrays
  - Return clear error messages with exact format specified above
  - **Files affected**: `src/shared/vscode-serialization.ts` (new)
  - **Test criteria**: All focused tests pass in vitest

- [x] **Step 2: Integrate reconstruction into sidekick extension**
  - Import `reconstructVscodeObjects` and types from shared module
  - Create `vscodeFactories` object mapping type names to real `vscode` constructors
  - Apply transformation in command handler before `executeCommand`
  - **Files affected**: `extensions/sidekick/src/extension.ts`
  - **Test criteria**: Commands with VS Code objects work through Socket.IO

- [x] **Step 3: Update MCP tool description**
  - Update `workspace_execute_command` tool's `description` field to mention `$vscode` wrapper support
  - Update `args` parameter's `.describe()` with examples for each supported type
  - Include the fully nested Location example
  - **Files affected**: `src/services/mcp-server/mcp-server.ts`
  - **Test criteria**: Tool description includes complete serialization format documentation

- [x] **Step 4: Update documentation**
  - Add "VS Code Object Serialization" section to `docs/API.md` with:
    - Supported types table
    - JSON format examples for each type
    - Nested object example (Location)
    - Error message formats
  - Update AGENTS.md MCP Server section to note `$vscode` wrapper support with reference to API.md
  - **Files affected**: `docs/API.md`, `AGENTS.md`
  - **Test criteria**: Documentation is clear and complete

## Testing Strategy

### Focused Tests (pure utility function in src/shared/)

The `reconstructVscodeObjects` function is pure TypeScript with injected factories, testable in vitest.

| #   | Test Case                              | Function                   | Input/Output                                                                                   |
| --- | -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Uri wrapper reconstruction             | `reconstructVscodeObjects` | `{ "$vscode": "Uri", "value": "file:///test" }` → factory called with value                    |
| 2   | Position wrapper reconstruction        | `reconstructVscodeObjects` | `{ "$vscode": "Position", "line": 0, "character": 5 }` → factory called                        |
| 3   | Range wrapper reconstruction           | `reconstructVscodeObjects` | `{ "$vscode": "Range", "start": {...}, "end": {...} }` → nested positions reconstructed first  |
| 4   | Selection wrapper reconstruction       | `reconstructVscodeObjects` | `{ "$vscode": "Selection", "anchor": {...}, "active": {...} }` → factory called                |
| 5   | Location wrapper reconstruction        | `reconstructVscodeObjects` | `{ "$vscode": "Location", "uri": {...}, "range": {...} }` → nested uri/range reconstructed     |
| 6   | Nested wrappers in plain object        | `reconstructVscodeObjects` | `{ label: "foo", uri: { "$vscode": "Uri", ... } }` → label unchanged, uri reconstructed        |
| 7   | Nested wrappers in array               | `reconstructVscodeObjects` | `[{ "$vscode": "Uri", ... }, "plain"]` → first reconstructed, second unchanged                 |
| 8   | Plain object passthrough               | `reconstructVscodeObjects` | `{ foo: "bar" }` → unchanged, no factory calls                                                 |
| 9   | Plain array passthrough                | `reconstructVscodeObjects` | `[1, 2, 3]` → unchanged                                                                        |
| 10  | Primitives passthrough                 | `reconstructVscodeObjects` | `"string"`, `42`, `true`, `null` → unchanged                                                   |
| 11  | Unknown $vscode type error             | `reconstructVscodeObjects` | `{ "$vscode": "Unknown" }` → throws with message containing "Unknown" and supported types      |
| 12  | Uri missing value error                | `reconstructVscodeObjects` | `{ "$vscode": "Uri" }` → throws "missing required field \"value\""                             |
| 13  | Position missing line error            | `reconstructVscodeObjects` | `{ "$vscode": "Position", "character": 0 }` → throws "missing required field \"line\""         |
| 14  | Position missing character error       | `reconstructVscodeObjects` | `{ "$vscode": "Position", "line": 0 }` → throws "missing required field \"character\""         |
| 15  | Position invalid line type error       | `reconstructVscodeObjects` | `{ "$vscode": "Position", "line": "0", "character": 0 }` → throws "must be a number"           |
| 16  | Range with invalid nested Position     | `reconstructVscodeObjects` | `{ "$vscode": "Range", "start": { "$vscode": "Position" }, "end": {...} }` → throws for nested |
| 17  | Mixed object with primitives preserved | `reconstructVscodeObjects` | `{ label: "test", count: 5, uri: { "$vscode": "Uri", ... } }` → label/count unchanged          |

### Integration Tests

| #   | Test Case                                    | Entry Point            | Boundary Mocks | Behavior Verified                                        |
| --- | -------------------------------------------- | ---------------------- | -------------- | -------------------------------------------------------- |
| 1   | Args with $vscode pass through MCP unchanged | `McpServer.handleTool` | API mock       | Args array passed to executeCommand without modification |

### Manual Testing Checklist

- [ ] Open file via MCP:
  ```json
  {
    "command": "vscode.open",
    "args": [{ "$vscode": "Uri", "value": "file:///c:/path/to/file.ts" }]
  }
  ```
- [ ] Go to location via MCP:
  ```json
  {
    "command": "editor.action.goToLocations",
    "args": [
      { "$vscode": "Uri", "value": "file:///c:/path/to/file.ts" },
      { "$vscode": "Position", "line": 10, "character": 0 },
      [
        {
          "$vscode": "Location",
          "uri": { "$vscode": "Uri", "value": "file:///..." },
          "range": {
            "$vscode": "Range",
            "start": { "$vscode": "Position", "line": 5, "character": 0 },
            "end": { "$vscode": "Position", "line": 5, "character": 10 }
          }
        }
      ]
    ]
  }
  ```
- [ ] Verify error message when using unknown `$vscode` type shows supported types
- [ ] Verify error message when wrapper is malformed shows which field is missing/invalid

## Dependencies

No new dependencies required. Uses only the `vscode` module which is already available in the extension context.

| Package | Purpose | Approved |
| ------- | ------- | -------- |
| (none)  | -       | -        |

## Documentation Updates

### Files to Update

| File          | Changes Required                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/API.md` | Add "VS Code Object Serialization" section with supported types, JSON formats, examples, error messages                                                                   |
| `AGENTS.md`   | Add note to MCP Server section: "Commands requiring VS Code objects (Uri, Position, Range, etc.) use `$vscode` wrapper format. See docs/API.md for serialization format." |

### New Documentation Required

| File   | Purpose |
| ------ | ------- |
| (none) | -       |

## Definition of Done

- [ ] All implementation steps complete
- [ ] `pnpm validate:fix` passes
- [ ] Documentation updated
- [ ] User acceptance testing passed
- [ ] CI passed
- [ ] Merged to main
