import type { HttpClient } from "../../boundaries/platform/network";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { Config } from "../../boundaries/platform/config";
import { configString } from "../../boundaries/platform/config-definition";
import type { AutoWorkspaceSource, PollResult, PollItem } from "./source";

// =============================================================================
// Constants
// =============================================================================

const YOUTRACK_FIELDS =
  "id,idReadable,summary,description,reporter(login,fullName),created,updated,resolved,project(id,name,shortName),customFields(name,value(name))";

// =============================================================================
// Source Factory
// =============================================================================

export interface YouTrackSourceDeps {
  readonly httpClient: HttpClient;
  readonly logger: Logger;
  readonly configService: Config;
}

export function createYouTrackSource(deps: YouTrackSourceDeps): AutoWorkspaceSource {
  const baseUrlConfig = deps.configService.register("experimental.youtrack.base-url", {
    default: null,
    description: "YouTrack instance URL (e.g. https://youtrack.example.com)",
    sensitive: true,
    ...configString({ nullable: true }),
  });
  const tokenConfig = deps.configService.register("experimental.youtrack.token", {
    default: null,
    description: "YouTrack API permanent token",
    sensitive: true,
    ...configString({ nullable: true }),
  });
  const queryConfig = deps.configService.register("experimental.youtrack.query", {
    default: null,
    description: "YouTrack search query (e.g. for:me State: {In Progress})",
    ...configString({ nullable: true }),
  });

  function youtrackHeaders(): Readonly<Record<string, string>> {
    return {
      Authorization: `Bearer ${tokenConfig.get()}`,
      Accept: "application/json",
    };
  }

  async function fetchIssues(): Promise<Record<string, unknown>[]> {
    const baseUrl = baseUrlConfig.get();
    const query = encodeURIComponent(queryConfig.get() ?? "");
    const fields = encodeURIComponent(YOUTRACK_FIELDS);
    const url = `${baseUrl}/api/issues?query=${query}&fields=${fields}`;

    const response = await deps.httpClient.fetch(url, {
      timeout: 15000,
      headers: youtrackHeaders(),
    });

    if (!response.ok) {
      throw new Error(`YouTrack API returned ${response.status}`);
    }

    return (await response.json()) as Record<string, unknown>[];
  }

  function issueStateKey(issueId: string): string {
    const baseUrl = baseUrlConfig.get();
    return `${baseUrl}/api/issues/${issueId}`;
  }

  return {
    name: "youtrack",
    fetchBasesBeforeDelete: false,

    isConfigured(): boolean {
      return (
        baseUrlConfig.get() !== null && tokenConfig.get() !== null && queryConfig.get() !== null
      );
    },

    async initialize(): Promise<boolean> {
      return true;
    },

    async poll(trackedKeys: ReadonlySet<string>): Promise<PollResult> {
      const issues = await fetchIssues();

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
          url: `${baseUrlConfig.get()}/issue/${idReadable}`,
          data: issue,
        });
      }

      return { activeKeys, newItems };
    },

    dispose(): void {
      // No runtime state to clean up; config lives in configService
    },
  };
}
