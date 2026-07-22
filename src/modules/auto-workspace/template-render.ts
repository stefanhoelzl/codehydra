/**
 * Render a source's structured `template` object into a workspace definition.
 *
 * Every string leaf in the template is a Liquid template evaluated against the
 * cmd's emitted JSON object. Non-string leaves pass through. Known top-level
 * keys map to workspace-creation fields; `agent` and `metadata` are nested
 * mappings (see buildAgentSpec / flattenMetadata).
 */

import { renderTemplate } from "../../utils/liquid/liquid-renderer";
import { isValidMetadataKey, type AgentSpec, type PromptModel } from "../../shared/api/types";
import type { TemplateObject, TemplateValue } from "./source-config";

export interface WorkspaceDefinition {
  readonly name: string;
  /** Dedup key. Defaults to the rendered name when the template omits `key`. */
  readonly key: string;
  readonly base?: string;
  readonly tracking?: string;
  readonly focus?: boolean;
  readonly project?: string;
  readonly git?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly agent?: AgentSpec;
  readonly prompt: string;
}

export interface RenderResult {
  readonly definition: WorkspaceDefinition;
  readonly warnings: readonly string[];
}

function isPlainObject(value: TemplateValue | undefined): value is TemplateObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: TemplateValue | undefined): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Render a workspace definition from the template object and item data.
 *
 * `template.name` is required and validated at parse time, so it is always a
 * string here. Throws only if Liquid rendering itself fails (caller treats a
 * throw as "skip this item, retry next tick").
 */
export function renderDefinition(template: TemplateObject, data: unknown): RenderResult {
  const warnings: string[] = [];
  const ctx = (data ?? {}) as Record<string, unknown>;
  const renderOpt = (value: TemplateValue | undefined): string | undefined =>
    value === undefined || value === null
      ? undefined
      : typeof value === "string"
        ? renderTemplate(value, ctx)
        : String(value);

  const name = renderOpt(template.name) ?? "";
  const key = renderOpt(template.key) ?? name;
  const base = renderOpt(template.base);
  const tracking = renderOpt(template.tracking);
  const project = renderOpt(template.project);
  const git = renderOpt(template.git);

  let focus: boolean | undefined;
  const focusRaw = template.focus;
  if (typeof focusRaw === "boolean") {
    focus = focusRaw;
  } else if (typeof focusRaw === "string") {
    const rendered = renderTemplate(focusRaw, ctx).trim();
    if (rendered === "true") focus = true;
    else if (rendered === "false") focus = false;
    else warnings.push(`Invalid focus value "${rendered}", expected "true" or "false"`);
  }

  const prompt = renderOpt(template.prompt) ?? "";
  const agent = isPlainObject(template.agent)
    ? buildAgentSpec(template.agent, prompt, ctx, warnings)
    : undefined;
  const metadata = isPlainObject(template.metadata)
    ? flattenMetadata(template.metadata, ctx, warnings)
    : undefined;

  const definition: WorkspaceDefinition = {
    name,
    key,
    prompt,
    ...(base !== undefined && { base }),
    ...(tracking !== undefined && { tracking }),
    ...(project !== undefined && { project }),
    ...(git !== undefined && { git }),
    ...(focus !== undefined && { focus }),
    ...(agent !== undefined && { agent }),
    ...(metadata !== undefined && Object.keys(metadata).length > 0 && { metadata }),
  };

  return { definition, warnings };
}

/**
 * Build an AgentSpec from the nested `agent` mapping:
 *   agent: { type, name, permission-mode, model: { provider, id } }
 * An invalid or missing `agent.type` (with other agent config present) assumes
 * "claude" with a warning, mirroring the previous behavior.
 */
function buildAgentSpec(
  agentObj: TemplateObject,
  prompt: string,
  ctx: Record<string, unknown>,
  warnings: string[]
): AgentSpec | undefined {
  const str = (v: TemplateValue | undefined): string | undefined =>
    v === undefined || v === null
      ? undefined
      : typeof v === "string"
        ? renderTemplate(v, ctx)
        : String(v);

  const agentType = str(agentObj.type);
  const agentName = str(agentObj.name);
  const permissionMode = str(agentObj["permission-mode"]);

  let model: PromptModel | undefined;
  const modelObj = agentObj.model;
  if (isPlainObject(modelObj)) {
    const providerID = str(modelObj.provider);
    const modelID = str(modelObj.id);
    if (providerID !== undefined && modelID !== undefined) {
      model = { providerID, modelID };
    } else if (providerID !== undefined || modelID !== undefined) {
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
    warnings.push(
      agentType !== undefined
        ? `Invalid agent.type "${agentType}", expected "claude" or "opencode"; assuming claude`
        : "agent.type is required to set a model, permission mode or named agent; assuming claude"
    );
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

/**
 * Flatten the nested `metadata` mapping into dotted `key -> string` entries.
 *
 * - A scalar leaf becomes its rendered string value.
 * - A nested object whose values are all scalars (e.g. a tag `{ color: "#..." }`)
 *   is rendered then JSON-stringified — this is how `metadata.tags.<name>` yields
 *   the JSON string the tag system expects.
 * - A nested object containing further objects is recursed as a namespace.
 *
 * Invalid metadata keys are dropped with a warning.
 */
function flattenMetadata(
  metaObj: TemplateObject,
  ctx: Record<string, unknown>,
  warnings: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  const renderScalar = (v: string | number | boolean): string =>
    typeof v === "string" ? renderTemplate(v, ctx) : String(v);

  const renderScalarObject = (obj: TemplateObject): Record<string, string | number | boolean> =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, isScalar(v) ? renderScalar(v) : String(v ?? "")])
    );

  const emit = (key: string, value: string): void => {
    if (isValidMetadataKey(key)) out[key] = value;
    else warnings.push(`Invalid metadata key: "${key}"`);
  };

  const walk = (prefix: string, value: TemplateValue): void => {
    if (isScalar(value)) {
      if (prefix !== "") emit(prefix, renderScalar(value));
      return;
    }
    if (!isPlainObject(value)) return;
    const entries = Object.entries(value);
    const allScalar = entries.length > 0 && entries.every(([, v]) => isScalar(v));
    if (prefix !== "" && allScalar) {
      emit(prefix, JSON.stringify(renderScalarObject(value)));
      return;
    }
    for (const [k, v] of entries) {
      walk(prefix === "" ? k : `${prefix}.${k}`, v);
    }
  };

  walk("", metaObj);
  return out;
}
