/**
 * One-shot migration of the old `experimental.github.*` / `experimental.youtrack.*`
 * config into a seeded `auto-workspace.sources` multi-document YAML value.
 *
 * The old per-source fetching (REST via HttpClient + `gh auth token`) becomes an
 * inline `cmd`:
 *   - github: a single `gh api graphql` call, reshaped with `--jq` back into the
 *     field shape the old template expects ({number,title,html_url,body,
 *     user.login,head.ref,base.ref,clone_url}).
 *   - youtrack: a `curl` with the base-url/token/query inlined.
 *
 * The old front-matter template string is converted into the new nested
 * `template` object, and a `key` matching the old state key is injected so
 * existing tracking survives the upgrade.
 */

import { stringify } from "yaml";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { TemplateObject } from "./source-config";

export const DEFAULT_GITHUB_QUERY = "is:open is:pr review-requested:@me";

const YOUTRACK_FIELDS =
  "id,idReadable,summary,description,reporter(login,fullName),created,updated,resolved,project(id,name,shortName),customFields(name,value(name))";

const GITHUB_GRAPHQL =
  "query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{... on PullRequest{number title url body headRefName baseRefName author{login} repository{url}}}}}";

const GITHUB_JQ =
  '[.data.search.nodes[]|{number,title,html_url:.url,body,user:{login:.author.login},head:{ref:.headRefName},base:{ref:.baseRefName},clone_url:(.repository.url+".git")}]';

/** POSIX single-quote a string for safe embedding in a `sh -c` command line. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function setNested(obj: Record<string, unknown>, path: string[], value: string): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (typeof cur[seg] !== "object" || cur[seg] === null) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

/**
 * Convert an old front-matter Liquid template string into the new nested
 * template object. Front-matter `key: value` lines become nested entries
 * (dotted keys → nested maps); the body becomes `prompt`. Deprecated bare
 * `agent` / `model.*` keys are dropped with a warning.
 */
export function frontMatterToTemplate(raw: string, logger: Logger): TemplateObject {
  const OPEN = "---\n";
  const obj: Record<string, unknown> = {};

  if (!raw.startsWith(OPEN)) {
    if (raw.trim() !== "") obj.prompt = raw;
    return obj as TemplateObject;
  }
  const rest = raw.slice(OPEN.length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) {
    if (raw.trim() !== "") obj.prompt = raw;
    return obj as TemplateObject;
  }

  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length).replace(/^\n/, "");

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key === "agent" || key === "model.provider" || key === "model.id") {
      logger.warn("Dropped deprecated front-matter key during migration", { key });
      continue;
    }
    setNested(obj, key.split("."), value);
  }
  if (body.trim() !== "") obj.prompt = body;
  return obj as TemplateObject;
}

export interface SeedInput {
  readonly github?: { readonly template: string; readonly query: string };
  readonly youtrack?: {
    readonly template: string;
    readonly baseUrl: string;
    readonly token: string;
    readonly query: string;
  };
}

function withKey(template: TemplateObject, key: string): TemplateObject {
  return template.key !== undefined ? template : { ...template, key };
}

/**
 * Build the seeded multi-document YAML, or null when there is nothing to
 * migrate. Each document renders `name`, `type`, `cmd`, `template`.
 */
export function buildSeededSources(input: SeedInput, logger: Logger): string | null {
  const docs: string[] = [];

  if (input.github) {
    const template = withKey(
      frontMatterToTemplate(input.github.template, logger),
      "{{ html_url }}"
    );
    const cmd = `gh api graphql -f q=${shq(input.github.query)} -f query=${shq(
      GITHUB_GRAPHQL
    )} --jq ${shq(GITHUB_JQ)}`;
    docs.push(stringify({ name: "github", type: "cron", cmd, template }));
  }

  if (input.youtrack) {
    const { baseUrl, token, query } = input.youtrack;
    const template = withKey(
      frontMatterToTemplate(input.youtrack.template, logger),
      `${baseUrl}/api/issues/{{ id }}`
    );
    const cmd = `curl -s -G -H ${shq(`Authorization: Bearer ${token}`)} --data-urlencode ${shq(
      `query=${query}`
    )} --data-urlencode ${shq(`fields=${YOUTRACK_FIELDS}`)} ${shq(`${baseUrl}/api/issues`)}`;
    docs.push(stringify({ name: "youtrack", type: "cron", cmd, template }));
  }

  if (docs.length === 0) return null;
  return docs.join("---\n");
}
