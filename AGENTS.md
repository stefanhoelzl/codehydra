# AI Agent Instructions for Chime Development

This document contains specific instructions for AI coding agents (Claude, etc.) working on the Chime project.

---

## Running the Application

Before making changes, verify the app works:

```bash
pnpm tauri dev
```

This starts the full Tauri application with hot reload.

---

## Definition of "Done" - Quality Checks

Before marking any feature as complete, you MUST run all these checks and ensure they pass:

### 1. TypeScript Strict Type Checking ✓

```bash
pnpm check
```

**Must pass with zero errors.** The project uses TypeScript strict mode.

### 2. ESLint (when configured)

```bash
pnpm lint
```

**Must pass with zero errors.** Fix any code quality issues.

### 3. Prettier Formatting (when configured)

```bash
pnpm format:check
```

**Must pass.** All code must be properly formatted. Run `pnpm format` to auto-fix.

### 4. Rust Clippy

```bash
pnpm rust:clippy
```

Equivalent to:

```bash
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
```

**Must pass with zero warnings.** Clippy warnings are treated as errors (`-D warnings`).

**Note:** Clippy requires a modern Rust toolchain installed via rustup. If clippy is not available:

```bash
# Install rustup if not available
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Then install clippy
rustup component add clippy
```

If rustup is not available on your system, clippy checks may be skipped, but they should be run before final review.

### 5. Rust Formatting

```bash
pnpm rust:fmt:check
```

Equivalent to:

```bash
cd src-tauri && cargo fmt --all -- --check
```

**Must pass.** All Rust code must follow standard formatting. Run `pnpm rust:fmt` to auto-fix.

**Note:** Rustfmt requires a modern Rust toolchain installed via rustup. If rustfmt is not available, install it:

```bash
rustup component add rustfmt
```

If rustup is not available on your system, rustfmt checks may be skipped, but they should be run before final review.

### 6. Complete Build

```bash
pnpm build              # Frontend only
pnpm build:debug        # Full Tauri app (faster)
```

**Must complete successfully.** Verify the app builds without errors.

### 7. Run All Checks at Once

```bash
pnpm validate
```

This runs all frontend checks and build (TypeScript, ESLint, Prettier, build).

For full validation including Rust checks (requires rustup):

```bash
pnpm validate:full
```

**Everything must pass.**

---

## Agent Workflow

When implementing a feature:

1. **Read AGENTS.md** for project context and architecture
2. **Implement the feature** following the patterns described
3. **Run `pnpm validate`** to check all quality gates
4. **Fix any issues** reported by the checks
5. **Test in dev mode**: `pnpm tauri dev`
6. **Test the build**: `pnpm build:debug`
7. **Verify everything works** before marking as done

---

## Code Quality Standards

### TypeScript/Svelte

- **Strict mode enabled** - No `any` types without justification
- **NEVER add TypeScript exceptions** (`// @ts-ignore`, `// @ts-expect-error`, `any` types) without explicit approval from the project owner
- Use **Svelte 5 runes** syntax ($state, $effect, etc.)
- Follow **SvelteKit conventions** for routing
- Prefer **explicit types** over inference where it improves clarity

### Rust

- **Zero clippy warnings** - All warnings must be addressed
- **NEVER add clippy exceptions** (`#[allow(clippy::...)]`) without explicit approval from the project owner
- Use **Result<T, E>** for error handling, never panic in library code
- Follow the **Provider pattern** (see INITIAL_CONCEPT.md)
- Use **async/await** for concurrent operations
- Add **doc comments** for public APIs

### Linting Exceptions

- **DO NOT add ESLint disable comments** (`eslint-disable`, `eslint-disable-next-line`) without explicit approval from the project owner
- **DO NOT suppress warnings** - Fix the underlying issue instead
- **DO NOT modify ignore patterns** (`.prettierignore`, `.eslintignore`, `ignores` in `eslint.config.js`) without explicit approval from the project owner
- If you believe an exception is necessary, document why and wait for human review

### General

- **No console.log in production code** - Use proper logging
- **No commented-out code** - Remove or explain why it's there
- **Consistent formatting** - Let Prettier/Rustfmt handle it
- **Descriptive variable names** - Code should be self-documenting

---

## Critical Rules

1. **Always run `pnpm validate` before marking a feature as done**
2. **Never commit code that doesn't pass all checks**
3. **NEVER add type/lint exceptions without explicit human approval** - This includes:
   - TypeScript: `any`, `@ts-ignore`, `@ts-expect-error`
   - ESLint: `eslint-disable`, `eslint-disable-next-line`
   - Rust Clippy: `#[allow(clippy::...)]`
   - Ignore patterns: modifications to `.prettierignore`, `.eslintignore`, or `ignores` in `eslint.config.js`
4. **Never ignore compiler warnings** - Fix the underlying issue
5. **Always test in both dev and build modes**
6. **Read CLAUDE.md for architecture patterns before implementing**
7. **Follow the Provider pattern for backend components**

---

## Installing New Dependencies

### JavaScript/TypeScript Dependencies

**ALWAYS use `pnpm add` or `pnpm add -D`** to install new packages. This ensures you get the latest compatible versions.

```bash
# Production dependency
pnpm add package-name

# Development dependency
pnpm add -D package-name
```

**NEVER manually edit `package.json`** to add dependencies - always use the pnpm command.

### Rust Dependencies

**ALWAYS use `cargo add`** to install new Rust crates. This ensures you get the latest compatible versions.

```bash
cd src-tauri
cargo add crate-name

# With specific features
cargo add crate-name --features feature1,feature2

# Development dependency
cargo add --dev crate-name
```

**NEVER manually edit `Cargo.toml`** to add dependencies - always use the cargo add command.

---

## Quick Reference

| Check       | Command               | Must Pass           |
| ----------- | --------------------- | ------------------- |
| TypeScript  | `pnpm check`          | ✓ Zero errors       |
| ESLint      | `pnpm lint`           | ✓ Zero errors       |
| Prettier    | `pnpm format:check`   | ✓ All formatted     |
| Rust Clippy | `pnpm rust:clippy`    | ✓ Zero warnings     |
| Rust Format | `pnpm rust:fmt:check` | ✓ All formatted     |
| Build       | `pnpm build:debug`    | ✓ Completes         |
| All Checks  | `pnpm validate`       | ✓ Everything passes |

---

**When in doubt, run `pnpm validate`. If it passes, you're good to go.**
