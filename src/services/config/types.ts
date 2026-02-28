/**
 * Configuration types for the application.
 */

/**
 * Agent types that can be selected by the user.
 * null indicates the user hasn't made a selection yet (first-run).
 */
export type ConfigAgentType = "claude" | "opencode" | null;
