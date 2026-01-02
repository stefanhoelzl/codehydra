# Code Quality Standards

Quality assessment for the CodeHydra codebase, designed for AI agent review.

## Related Documentation

| Document                                 | Quality Relevance                                      |
| ---------------------------------------- | ------------------------------------------------------ |
| [AGENTS.md](../AGENTS.md)                | Critical rules, forbidden patterns, required practices |
| [PATTERNS.md](./PATTERNS.md)             | Implementation patterns with code examples             |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | System structure, component relationships, layers      |
| [TESTING.md](./TESTING.md)               | Testing strategy, test types, behavioral mocks         |
| [API.md](./API.md)                       | API contracts, type definitions                        |
| [USER_INTERFACE.md](./USER_INTERFACE.md) | UI conventions, user flows, keyboard navigation        |

## Quality Topics

### Architecture

Reviews structural integrity across the codebase:

- **Layer violations**: platform ↔ shell, renderer ↔ main process boundaries
- **Circular dependencies**: Modules importing each other
- **God modules**: Files with too many responsibilities (>500 lines, >10 exports)
- **Boundary interface violations**: Direct fs/fetch/execa usage bypassing abstractions (see AGENTS.md "External System Access Rules")
- **Dependency injection**: Improper DI patterns
- **Cross-cutting concerns**: Logging, error handling leaking into domain logic

**Reference:** [ARCHITECTURE.md](./ARCHITECTURE.md), [AGENTS.md](../AGENTS.md) § External System Access Rules

### Code Quality

Reviews code patterns that spread across the codebase (not localized issues):

- **Duplicated logic**: Similar code across multiple modules that should be extracted
- **Inconsistent abstraction levels**: Some modules high-level, similar ones low-level
- **Scattered responsibilities**: Feature logic spread across unrelated files
- **Dead code patterns**: Unused exports, unreachable branches across modules
- **Complexity hotspots**: Modules that are consistently hard to understand
- **Copy-paste code**: Repeated patterns that should be utilities

**Reference:** [AGENTS.md](../AGENTS.md) § Code Quality Standards

### Consistency

Reviews adherence to established patterns:

- **Pattern deviations**: Code that doesn't follow docs/PATTERNS.md
- **Error handling**: Inconsistent approaches (throw vs return vs log)
- **Naming conventions**: Service vs Manager vs Client inconsistency
- **Async patterns**: Mixed callbacks, promises, async/await
- **Return type patterns**: Inconsistent across similar functions

**Reference:** [PATTERNS.md](./PATTERNS.md)

### Documentation

Reviews documentation quality and completeness:

- **Completeness**: Are all public APIs documented? Missing sections?
- **AI-agent readability**: Clear structure, decision trees, actionable guidance
- **Accuracy**: Does documentation match actual code behavior?
- **Freshness**: Outdated examples, deprecated patterns still documented
- **Cross-references**: Do docs link to each other appropriately?
- **Actionable guidance**: Do docs tell you _what to do_, not just _what exists_?

**Reference:** All docs/\*.md files, [AGENTS.md](../AGENTS.md)

### Type Safety

Reviews TypeScript usage for correctness enforcement:

- **tsconfig strictness**: Is strict mode fully enabled? All strict flags on?
- **API type design**: Do types guide correct usage and prevent misuse?
  - Can you call an API incorrectly and have it compile?
  - Are discriminated unions used where appropriate?
  - Are optional vs required properties correct?
- **Generic usage**: Are generics used to enforce constraints?
- **Type narrowing**: Are type guards used appropriately?
- **Branded types**: Are distinct primitives (IDs, paths) distinguished?

**Reference:** tsconfig.json, [AGENTS.md](../AGENTS.md) § Code Quality Standards

### Testing

Reviews testing strategy enforcement:

- **TESTING.md compliance**: Are the documented test types being used correctly?
- **Boundary tests**: Used for external interfaces (git, fs, http, processes)?
- **Integration tests**: Used instead of deprecated unit tests?
- **Behavioral mocks**: Used instead of structural mocks?
- **Coverage**: Are public APIs covered by tests?
- **Test quality**: Meaningful assertions, not just "doesn't throw"?
- **Test performance**: Are integration tests fast (<50ms)?

**Reference:** [TESTING.md](./TESTING.md), vitest.config.ts

### Infrastructure

Reviews project health and tooling:

- **Dependencies**: Unused deps, duplicate deps, significantly outdated packages
- **Project layout**: Files in wrong directories, orphaned files
- **Tooling config**: ESLint, Prettier, TypeScript configs aligned and consistent
- **Build scripts**: Maintainable, documented, following patterns
- **CI/CD**: Workflows complete and correct
- **Non-production code**: Quality of scripts, tools, dev utilities

**Reference:** package.json, eslint.config.js, .github/workflows/

### UX

Reviews user experience quality:

- **Accessibility**: ARIA attributes, keyboard navigation, screen reader support
- **UI pattern adherence**: Consistent with docs/USER_INTERFACE.md
- **User flow completeness**: Are flows complete and intuitive?
- **Keyboard shortcuts**: Documented and working?
- **Visual consistency**: CSS variables, theming patterns followed
- **Error state UX**: Are error UIs helpful and informative?

**Reference:** [USER_INTERFACE.md](./USER_INTERFACE.md), [PATTERNS.md](./PATTERNS.md) § UI Patterns

## Accepted Patterns

The following are acknowledged issues that are intentionally accepted.
Add patterns here with explanations when issues are discovered but deemed acceptable.

### Type Safety

- Preload script (`src/preload/index.ts`) uses patterns required by Electron's contextBridge API that appear unsafe but are necessary

### Architecture

- (none currently)

### Code Quality

- (none currently)

### Consistency

- (none currently)

### Documentation

- (none currently)

### Testing

- (none currently)

### Infrastructure

- (none currently)

### UX

- (none currently)
