import { describe, it, expect, vi, beforeEach } from "vitest";
import { getConfig } from "./config";

// Mock vscode
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: vi.fn(),
  },
}));

import * as vscode from "vscode";

describe("getConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns default values when no configuration set", () => {
    const mockGet = vi
      .fn()
      .mockImplementation((_key: string, defaultValue: unknown) => defaultValue);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: mockGet,
    } as unknown as vscode.WorkspaceConfiguration);

    const config = getConfig();

    expect(config.provider).toBe("auto");
    expect(config.assemblyaiApiKey).toBe("");
    expect(config.silenceTimeout).toBe(10);
  });

  it("returns configured values", () => {
    const mockGet = vi.fn().mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        provider: "assemblyai",
        "assemblyai.apiKey": "test-api-key",
        silenceTimeout: 30,
      };
      return values[key];
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: mockGet,
    } as unknown as vscode.WorkspaceConfiguration);

    const config = getConfig();

    expect(config.provider).toBe("assemblyai");
    expect(config.assemblyaiApiKey).toBe("test-api-key");
    expect(config.silenceTimeout).toBe(30);
  });
});
