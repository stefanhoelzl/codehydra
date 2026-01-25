# CodeHydra Documentation

Documentation for the CodeHydra project.

## Quick Reference

| Document            | Purpose                                          | When to Use                    |
| ------------------- | ------------------------------------------------ | ------------------------------ |
| [ARCHITECTURE.md]   | High-level system design, layers, components     | Understanding system structure |
| [SERVICES.md]       | Service layer implementation, abstractions       | Working with services          |
| [AGENTS.md]         | Agent provider interface and integration         | Adding/modifying agent support |
| [PATTERNS.md]       | IPC, UI, CSS patterns and conventions            | Following code patterns        |
| [API.md]            | Private/Public API reference                     | API usage and integration      |
| [USER_INTERFACE.md] | UI layout, user flows, dialogs, shortcuts        | UI/UX changes                  |
| [TESTING.md]        | Testing strategy, test types, conventions        | Writing tests                  |
| [QUALITY.md]        | Code quality standards, accepted patterns        | Quality reviews                |
| [PLANNING.md]       | Which docs to read for different change types    | Planning features              |
| [RELEASE.md]        | Version format, release workflow, Windows builds | Creating releases              |

## Document Focus

### System Understanding

- **ARCHITECTURE.md** - Start here for system overview. Contains layer architecture, component relationships, startup flows, and key diagrams.

- **SERVICES.md** - Deep dive into service implementation. Covers external system access rules, platform abstractions (FileSystemLayer, NetworkLayer, ProcessRunner), and mock factories.

- **AGENTS.md** - Agent integration system. How to implement new agents, status tracking, MCP integration, and OpenCode/Claude Code specifics.

### Development

- **PATTERNS.md** - Code conventions for IPC communication, VSCode Elements, Svelte 5 patterns, and CSS theming.

- **API.md** - Complete API reference including IPC channels, events, and Plugin API for extensions.

- **TESTING.md** - How to write tests. Test types (integration, boundary, focused), behavioral mocks, and coverage requirements.

### UI/UX

- **USER_INTERFACE.md** - User-facing documentation. Layout structure, dialog flows, keyboard shortcuts, and accessibility.

### Process

- **PLANNING.md** - Feature planning guide. What documents to read for each change type.

- **QUALITY.md** - Quality standards and accepted patterns for code reviews.

- **RELEASE.md** - Release process documentation.

## Change Type Quick Reference

| Change Type             | Read First                               |
| ----------------------- | ---------------------------------------- |
| Service layer changes   | SERVICES.md, ARCHITECTURE.md             |
| Agent integration       | AGENTS.md, SERVICES.md                   |
| IPC/API changes         | API.md, PATTERNS.md, ARCHITECTURE.md     |
| UI components           | USER_INTERFACE.md, PATTERNS.md           |
| New external dependency | SERVICES.md (External System Access)     |
| Testing infrastructure  | TESTING.md, SERVICES.md (Mock Factories) |

[ARCHITECTURE.md]: ./ARCHITECTURE.md
[SERVICES.md]: ./SERVICES.md
[AGENTS.md]: ./AGENTS.md
[PATTERNS.md]: ./PATTERNS.md
[API.md]: ./API.md
[USER_INTERFACE.md]: ./USER_INTERFACE.md
[TESTING.md]: ./TESTING.md
[QUALITY.md]: ./QUALITY.md
[PLANNING.md]: ./PLANNING.md
[RELEASE.md]: ./RELEASE.md
