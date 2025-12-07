/**
 * IPC payload validation using Zod schemas.
 * Provides type-safe validation with standardized error handling.
 *
 * NOTE: Zod schemas are defined here instead of shared/ipc.ts for browser compatibility.
 * The shared/ directory is used by the renderer process, which runs in a browser context.
 * Zod and Node.js path module cannot be used in browser code.
 * The payload types in shared/ipc.ts are the source of truth for the interface;
 * these schemas must match those types.
 */

import { z } from "zod";
import path from "node:path";

/**
 * Issue from Zod validation error.
 */
interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Validation error for IPC payloads.
 */
export class ValidationError extends Error {
  readonly type = "validation" as const;
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const message = issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    super(message);
    this.name = "ValidationError";
    this.issues = issues;
  }

  /**
   * Serializes the error for IPC transport.
   */
  toJSON(): { type: "validation"; message: string } {
    return {
      type: this.type,
      message: this.message,
    };
  }
}

/**
 * Path validation: absolute, no traversal, normalized.
 * Security measure against path traversal attacks.
 */
export const absolutePathSchema = z
  .string()
  .refine((p) => path.isAbsolute(p) && !p.includes("..") && p === path.normalize(p), {
    message: 'Path must be absolute, normalized, and contain no ".." segments',
  });

// ============ Payload Schemas ============

export const ProjectOpenPayloadSchema = z.object({
  path: absolutePathSchema,
});

export const ProjectClosePayloadSchema = z.object({
  path: absolutePathSchema,
});

export const WorkspaceCreatePayloadSchema = z.object({
  projectPath: absolutePathSchema,
  name: z.string().min(1).max(100),
  baseBranch: z.string().min(1),
});

export const WorkspaceRemovePayloadSchema = z.object({
  workspacePath: absolutePathSchema,
  deleteBranch: z.boolean(),
});

export const WorkspaceSwitchPayloadSchema = z.object({
  workspacePath: absolutePathSchema,
});

export const WorkspaceListBasesPayloadSchema = z.object({
  projectPath: absolutePathSchema,
});

export const WorkspaceUpdateBasesPayloadSchema = z.object({
  projectPath: absolutePathSchema,
});

export const WorkspaceIsDirtyPayloadSchema = z.object({
  workspacePath: absolutePathSchema,
});

/**
 * Validation schema for ui:set-dialog-mode payload.
 */
export const UISetDialogModePayloadSchema = z.object({
  isOpen: z.boolean(),
});

/**
 * Validates a payload against a Zod schema.
 *
 * @param schema - The Zod schema to validate against
 * @param payload - The payload to validate
 * @returns The validated and typed payload
 * @throws ValidationError if validation fails
 */
export function validate<T extends z.ZodSchema>(schema: T, payload: unknown): z.infer<T> {
  const result = schema.safeParse(payload);

  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }

  return result.data;
}
