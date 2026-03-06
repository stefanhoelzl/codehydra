import type { HttpClient } from "../../../services/platform/network";
import type { Logger } from "../../../services/logging/types";
import { configString } from "../../../services/config/config-definition";
import type { ConfigKeyDefinition } from "../../../services/config/config-definition";
import type { AutoWorkspaceSource, PollResult, PollItem } from "./source";
import { getErrorMessage } from "../../../shared/error-utils";

// =============================================================================
// Constants
// =============================================================================

const YOUTRACK_FIELDS =
  "id,idReadable,summary,description,reporter(login,fullName),created,updated,resolved,project(id,name,shortName),customFields(name,value(name))";

const CONFIG_KEYS = {
  baseUrl: "experimental.youtrack.base-url",
  token: "experimental.youtrack.token",
  query: "experimental.youtrack.query",
} as const;

// =============================================================================
// Source Factory
// =============================================================================

export interface YouTrackSourceDeps {
  readonly httpClient: HttpClient;
  readonly logger: Logger;
}

export function createYouTrackSource(deps: YouTrackSourceDeps): AutoWorkspaceSource {
  let configBaseUrl: string | null = null;
  let configToken: string | null = null;
  let configQuery: string | null = null;

  function youtrackHeaders(): Readonly<Record<string, string>> {
    return {
      Authorization: `Bearer ${configToken}`,
      Accept: "application/json",
    };
  }

  async function fetchIssues(): Promise<Record<string, unknown>[]> {
    const query = encodeURIComponent(configQuery!);
    const fields = encodeURIComponent(YOUTRACK_FIELDS);
    const url = `${configBaseUrl}/api/issues?query=${query}&fields=${fields}`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: youtrackHeaders(),
    });

    if (!response.ok) {
      deps.logger.warn("YouTrack API returned non-OK", { status: response.status });
      return [];
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  function issueStateKey(issueId: string): string {
    return `${configBaseUrl}/api/issues/${issueId}`;
  }

  return {
    name: "youtrack",

    configDefinitions(): ConfigKeyDefinition<unknown>[] {
      return [
        {
          name: CONFIG_KEYS.baseUrl,
          default: null,
          description: "YouTrack instance URL (e.g. https://youtrack.example.com)",
          ...configString({ nullable: true }),
        },
        {
          name: CONFIG_KEYS.token,
          default: null,
          description: "YouTrack API permanent token",
          ...configString({ nullable: true }),
        },
        {
          name: CONFIG_KEYS.query,
          default: null,
          description: "YouTrack search query (e.g. for:me State: {In Progress})",
          ...configString({ nullable: true }),
        },
      ];
    },

    onConfigUpdated(values: Record<string, unknown>): void {
      if (CONFIG_KEYS.baseUrl in values) {
        configBaseUrl = (values[CONFIG_KEYS.baseUrl] as string | null) ?? null;
      }
      if (CONFIG_KEYS.token in values) {
        configToken = (values[CONFIG_KEYS.token] as string | null) ?? null;
      }
      if (CONFIG_KEYS.query in values) {
        configQuery = (values[CONFIG_KEYS.query] as string | null) ?? null;
      }
    },

    isConfigured(): boolean {
      return configBaseUrl !== null && configToken !== null && configQuery !== null;
    },

    async initialize(): Promise<boolean> {
      return true;
    },

    async poll(trackedKeys: ReadonlySet<string>): Promise<PollResult> {
      deps.logger.debug("Polling YouTrack for issues");

      let issues: Record<string, unknown>[];
      try {
        issues = await fetchIssues();
      } catch (error) {
        deps.logger.warn("Failed to poll YouTrack", { error: getErrorMessage(error) });
        return { activeKeys: new Set(), newItems: [] };
      }

      const activeKeys = new Set<string>();
      const newItems: PollItem[] = [];

      for (const issue of issues) {
        const issueId = issue.id as string;
        const idReadable = issue.idReadable as string;
        const key = issueStateKey(issueId);
        activeKeys.add(key);

        if (trackedKeys.has(key)) continue;

        newItems.push({
          key,
          url: `${configBaseUrl}/issue/${idReadable}`,
          data: issue,
        });
      }

      return { activeKeys, newItems };
    },

    dispose(): void {
      configBaseUrl = null;
      configToken = null;
      configQuery = null;
    },
  };
}
