import { isValidMetadataKey, type AgentSpec, type PromptModel } from "../../shared/api/types";

export interface TemplateConfig {
  readonly name?: string;
  readonly base?: string;
  readonly tracking?: string;
  readonly focus?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly project?: string;
  readonly git?: string;
  readonly prompt: string;
  /**
   * Agent spec built from the `agent.*` front-matter (with a legacy-key shim).
   * Absent when the template sets no agent config — the caller falls back to a
   * prompt-only "default" arm.
   */
  readonly agent?: AgentSpec;
}

export interface ParseResult {
  readonly config: TemplateConfig;
  readonly warnings: readonly string[];
}

const FRONT_MATTER_OPEN = "---\n";
const KNOWN_KEYS = new Set([
  "name",
  "base",
  "tracking",
  "focus",
  "project",
  "git",
  // Agent spec (mirrors the AgentSpec union under an `agent.` namespace)
  "agent.type",
  "agent.name",
  "agent.permission-mode",
  "agent.model.provider",
  "agent.model.id",
  // Legacy (deprecated) — mapped onto a Claude agent arm with a warning.
  "agent",
  "model.provider",
  "model.id",
]);

/** Treat empty front-matter values ("key:" with no value) as unset. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

export function parseTemplateOutput(rendered: string): ParseResult {
  const warnings: string[] = [];

  if (!rendered.startsWith(FRONT_MATTER_OPEN)) {
    return { config: { prompt: rendered }, warnings };
  }

  // Find closing delimiter after the opening "---\n"
  const rest = rendered.slice(FRONT_MATTER_OPEN.length);
  const closeMatch = /^---[ \t]*$/m.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) {
    // No closing delimiter → treat entire string as prompt
    return { config: { prompt: rendered }, warnings };
  }

  const frontMatterBlock = rest.slice(0, closeMatch.index);
  const prompt = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, "");

  // Parse key-value lines
  const fields: Record<string, string> = {};
  const metadataFields: Record<string, string> = {};
  for (const line of frontMatterBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      warnings.push(`Ignoring front-matter line (no colon): "${trimmed}"`);
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (key.startsWith("metadata.")) {
      const metaKey = key.slice("metadata.".length);
      if (isValidMetadataKey(metaKey)) {
        metadataFields[metaKey] = value;
      } else {
        warnings.push(`Invalid metadata key: "${metaKey}"`);
      }
      continue;
    }

    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`Unknown front-matter key: "${key}"`);
      continue;
    }

    fields[key] = value;
  }

  // Build config
  let focus: boolean | undefined;
  if (fields["focus"] !== undefined) {
    if (fields["focus"] === "true") {
      focus = true;
    } else if (fields["focus"] === "false") {
      focus = false;
    } else {
      warnings.push(`Invalid focus value "${fields["focus"]}", expected "true" or "false"`);
    }
  }

  const agent = buildAgentSpec(fields, prompt, warnings);

  const config: TemplateConfig = {
    prompt,
    ...(fields["name"] !== undefined && { name: fields["name"] }),
    ...(fields["base"] !== undefined && { base: fields["base"] }),
    ...(fields["tracking"] !== undefined && { tracking: fields["tracking"] }),
    ...(focus !== undefined && { focus }),
    ...(Object.keys(metadataFields).length > 0 && { metadata: metadataFields }),
    ...(fields["project"] !== undefined && { project: fields["project"] }),
    ...(fields["git"] !== undefined && { git: fields["git"] }),
    ...(agent !== undefined && { agent }),
  };

  return { config, warnings };
}

/**
 * Build the AgentSpec from `agent.*` front-matter, applying the legacy-key shim.
 * Legacy keys (`agent`, `model.*`) and any agent config lacking a valid
 * `agent.type` assume `claude` (parser stays pure — no config lookup), so an
 * opencode-default user must migrate to keep portability.
 */
function buildAgentSpec(
  fields: Record<string, string>,
  prompt: string,
  warnings: string[]
): AgentSpec | undefined {
  const legacyAgentName = nonEmpty(fields["agent"]);
  const legacyModelProvider = nonEmpty(fields["model.provider"]);
  const legacyModelId = nonEmpty(fields["model.id"]);
  if (
    legacyAgentName !== undefined ||
    legacyModelProvider !== undefined ||
    legacyModelId !== undefined
  ) {
    warnings.push(
      "Front-matter keys 'agent', 'model.provider', 'model.id' are deprecated; " +
        "use 'agent.name' and 'agent.model.*' (with 'agent.type'). Legacy keys assume agent.type: claude."
    );
  }

  const agentType = nonEmpty(fields["agent.type"]);
  const agentName = nonEmpty(fields["agent.name"]) ?? legacyAgentName;
  const permissionMode = nonEmpty(fields["agent.permission-mode"]);
  const modelProvider = nonEmpty(fields["agent.model.provider"]) ?? legacyModelProvider;
  const modelId = nonEmpty(fields["agent.model.id"]) ?? legacyModelId;

  let model: PromptModel | undefined;
  if (modelProvider !== undefined || modelId !== undefined) {
    if (modelProvider !== undefined && modelId !== undefined) {
      model = { providerID: modelProvider, modelID: modelId };
    } else {
      warnings.push("Both the model provider and id must be specified together");
    }
  }

  const hasAgentConfig =
    agentType !== undefined ||
    agentName !== undefined ||
    permissionMode !== undefined ||
    model !== undefined;
  if (!hasAgentConfig) return undefined;

  let resolvedType: "claude" | "opencode";
  if (agentType === "claude" || agentType === "opencode") {
    resolvedType = agentType;
  } else {
    if (agentType !== undefined) {
      warnings.push(
        `Invalid agent.type "${agentType}", expected "claude" or "opencode"; assuming claude`
      );
    } else {
      warnings.push(
        "agent.type is required to set a model, permission mode or named agent; assuming claude"
      );
    }
    resolvedType = "claude";
  }

  if (resolvedType === "opencode") {
    if (permissionMode !== undefined) {
      warnings.push("agent.permission-mode is ignored for opencode");
    }
    return {
      type: "opencode",
      ...(prompt !== "" && { prompt }),
      ...(model !== undefined && { model }),
      ...(agentName !== undefined && { agentName }),
    };
  }

  return {
    type: "claude",
    ...(prompt !== "" && { prompt }),
    ...(model !== undefined && { model }),
    ...(permissionMode !== undefined && { permissionMode }),
    ...(agentName !== undefined && { agentName }),
  };
}
