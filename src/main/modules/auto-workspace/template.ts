import { isValidMetadataKey } from "../../../shared/api/types";

export interface TemplateConfig {
  readonly name?: string;
  readonly agent?: string;
  readonly base?: string;
  readonly focus?: boolean;
  readonly model?: { readonly providerID: string; readonly modelID: string };
  readonly metadata?: Readonly<Record<string, string>>;
  readonly project?: string;
  readonly git?: string;
  readonly prompt: string;
}

export interface ParseResult {
  readonly config: TemplateConfig;
  readonly warnings: readonly string[];
}

const FRONT_MATTER_OPEN = "---\n";
const KNOWN_KEYS = new Set([
  "name",
  "agent",
  "base",
  "focus",
  "model.provider",
  "model.id",
  "project",
  "git",
]);

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

  let model: { readonly providerID: string; readonly modelID: string } | undefined;
  if (fields["model.provider"] !== undefined || fields["model.id"] !== undefined) {
    if (fields["model.provider"] && fields["model.id"]) {
      model = { providerID: fields["model.provider"], modelID: fields["model.id"] };
    } else {
      warnings.push("Both model.provider and model.id must be specified together");
    }
  }

  const config: TemplateConfig = {
    prompt,
    ...(fields["name"] !== undefined && { name: fields["name"] }),
    ...(fields["agent"] !== undefined && { agent: fields["agent"] }),
    ...(fields["base"] !== undefined && { base: fields["base"] }),
    ...(focus !== undefined && { focus }),
    ...(model !== undefined && { model }),
    ...(Object.keys(metadataFields).length > 0 && { metadata: metadataFields }),
    ...(fields["project"] !== undefined && { project: fields["project"] }),
    ...(fields["git"] !== undefined && { git: fields["git"] }),
  };

  return { config, warnings };
}
