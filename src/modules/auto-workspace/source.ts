export interface PollItem {
  readonly key: string;
  readonly url: string;
  readonly data: Record<string, unknown>;
}

export interface PollResult {
  readonly activeKeys: ReadonlySet<string>;
  readonly newItems: readonly PollItem[];
}

export interface AutoWorkspaceSource {
  readonly name: string;
  readonly fetchBasesBeforeDelete: boolean;
  isConfigured(): boolean;
  initialize(): Promise<boolean>;
  poll(trackedKeys: ReadonlySet<string>): Promise<PollResult>;
  dispose(): void;
}
