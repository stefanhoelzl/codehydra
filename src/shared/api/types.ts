/**
 * API type definitions for CodeHydra.
 * Provides branded types for compile-time safety and runtime type guards for validation.
 */

import type { ProjectId, WorkspaceName } from "../../intents/contract";

// =============================================================================
// Identifier Types (Branded) — re-exported type-only from the intent contract
// =============================================================================
// zod is the single source of truth for these brands (src/intents/contract). This is a
// type-only re-export, erased at build, so renderer/preload keep importing ProjectId /
// WorkspaceName from here without pulling zod into their bundles. Imported locally too so
// the domain types below can reference them.

export type { ProjectId, WorkspaceName };

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Regex for validating WorkspaceName format.
 * Pattern: starts with alphanumeric, followed by alphanumeric, dashes, underscores, dots, or forward slashes.
 */
const WORKSPACE_NAME_REGEX = /^[a-zA-Z0-9][-_./a-zA-Z0-9]*$/;

/**
 * Maximum length for workspace names.
 */
const WORKSPACE_NAME_MAX_LENGTH = 100;

/**
 * Validate a workspace name and return an error message or null.
 * @param value String to validate
 * @returns Error message if invalid, null if valid
 */
export function validateWorkspaceName(value: string): string | null {
  if (!value) return "Name is required";
  if (value.length > WORKSPACE_NAME_MAX_LENGTH)
    return `Name must be ${WORKSPACE_NAME_MAX_LENGTH} characters or less`;
  if (value.includes("..")) return 'Name cannot contain ".."';
  if (value.includes("\\")) return 'Name cannot contain "\\"';
  if (!WORKSPACE_NAME_REGEX.test(value)) {
    return "Name can only contain letters, numbers, dash, underscore, dot, forward slash";
  }
  return null;
}

// =============================================================================
// Metadata Key Validation
// =============================================================================

/**
 * Regex for validating metadata key format.
 * Pattern: dot-separated segments, each starting with a letter followed by letters, digits, or hyphens.
 * No underscores (git config compatibility), no trailing hyphen per segment.
 *
 * Valid: base, note, model-name, AI-model, tags.bugfix, tags.my-tag
 * Invalid: _private (leading underscore), my_key (underscore), 123note (leading digit), note- (trailing hyphen), .foo (leading dot)
 */
export const METADATA_KEY_REGEX = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;

/**
 * Maximum length for metadata keys.
 */
const METADATA_KEY_MAX_LENGTH = 64;

/**
 * Validates a metadata key for workspace config storage.
 * Keys must:
 * - Be dot-separated segments (e.g., "tags.bugfix", "base")
 * - Each segment starts with a letter (a-z, A-Z)
 * - Each segment contains only letters, digits, and hyphens
 * - No segment ends with a hyphen
 * - Be 1-64 characters long
 *
 * @param key The key to validate
 * @returns True if the key is valid for metadata storage
 */
export function isValidMetadataKey(key: string): boolean {
  if (key.length === 0 || key.length > METADATA_KEY_MAX_LENGTH) {
    return false;
  }
  if (!METADATA_KEY_REGEX.test(key)) {
    return false;
  }
  // Check no segment ends with a hyphen
  const segments = key.split(".");
  return segments.every((segment) => !segment.endsWith("-"));
}

// =============================================================================
// Workspace Tags
// =============================================================================

/**
 * Metadata key prefix for workspace tags.
 * Tags are stored as metadata entries with keys like "tags.bugfix", "tags.wip".
 */
export const TAGS_METADATA_KEY_PREFIX = "tags.";

/**
 * A tag attached to a workspace.
 *
 * `name` is the identity — it is the metadata key's suffix, so it obeys
 * `isValidMetadataKey`. The rest is presentation and carries no identity:
 * `label` is displayed in place of the name (any UTF-8, typically an emoji),
 * `color` turns the bare label into a pill, and `description` is the hover text.
 */
export interface WorkspaceTag {
  readonly name: string;
  readonly color?: string;
  readonly label?: string;
  readonly description?: string;
}

/**
 * Read one string field out of a parsed tag object.
 *
 * Anything that is not a string is ignored rather than coerced: a tag written by
 * hand into git config should cost the one field it got wrong, never the tag.
 */
function readTagField(parsed: unknown, field: string): string | undefined {
  if (typeof parsed !== "object" || parsed === null || !(field in parsed)) return undefined;
  const candidate = (parsed as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Extract tags from a metadata record by filtering keys with "tags." prefix.
 * Parses JSON values and extracts the optional color, label and description fields.
 * Invalid JSON values produce tags with just the name.
 *
 * @param metadata Metadata record from workspace
 * @returns Array of workspace tags
 */
export function extractTags(metadata: Readonly<Record<string, string>>): WorkspaceTag[] {
  const tags: WorkspaceTag[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(TAGS_METADATA_KEY_PREFIX)) continue;
    const name = key.slice(TAGS_METADATA_KEY_PREFIX.length);
    if (name.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Invalid JSON — tag with just name
      parsed = undefined;
    }

    const color = readTagField(parsed, "color");
    const label = readTagField(parsed, "label");
    const description = readTagField(parsed, "description");

    tags.push({
      name,
      ...(color !== undefined ? { color } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }
  return tags;
}

// =============================================================================
// Workspace Title
// =============================================================================

/** Metadata key holding a workspace's user-given display title. */
export const TITLE_METADATA_KEY = "title";

/**
 * Interpret a raw metadata `title` into a display title: trim, and treat an
 * empty string as unset (undefined) so an emptied title reverts to the branch
 * name. Shared so every consumer (sidebar rows, window title) falls back
 * identically.
 *
 * @param value Raw metadata value; null/undefined when the key is unset
 * @returns The trimmed title, or undefined when there is none
 */
export function readTitle(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// =============================================================================
// Domain Types — re-exported type-only from the intent contract
// =============================================================================
// zod is the single source of truth for these (src/intents/contract). Type-only re-exports,
// erased at build, so renderer/preload import them from here without pulling zod into their
// bundles. The runtime helpers above (validateWorkspaceName, isValidMetadataKey, extractTags)
// and WorkspaceTag stay here — they carry no zod.

export type {
  Project,
  Workspace,
  WorkspaceRef,
  WorkspaceStatus,
  AgentStatus,
  AgentStatusCounts,
  BaseInfo,
  AgentType as ConfigAgentType,
  SetupRowId,
  SetupRowStatus,
  BlockingProcess,
  DeletionOperationId,
  DeletionOperationStatus,
  DeletionOperation,
  DeletionProgress,
  PromptModel,
  AgentSpec,
  AgentSession,
} from "../../intents/contract";
