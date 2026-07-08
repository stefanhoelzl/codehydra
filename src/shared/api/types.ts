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
 */
export interface WorkspaceTag {
  readonly name: string;
  readonly color?: string;
}

/**
 * Extract tags from a metadata record by filtering keys with "tags." prefix.
 * Parses JSON values and extracts optional color field.
 * Invalid JSON values produce tags with just the name (no color).
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

    let color: string | undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && "color" in parsed) {
        const candidate = (parsed as { color: unknown }).color;
        if (typeof candidate === "string") {
          color = candidate;
        }
      }
    } catch {
      // Invalid JSON — tag with just name
    }

    if (color !== undefined) {
      tags.push({ name, color });
    } else {
      tags.push({ name });
    }
  }
  return tags;
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
  ConfigAgentType,
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
