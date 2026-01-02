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
    expect(config.assemblyaiConnectionTimeout).toBe(2000);
    expect(config.autoStopDelay).toBe(5);
    expect(config.listeningDelay).toBe(300);
    expect(config.autoSubmit).toBe(true);
  });

  it("returns configured values", () => {
    const mockGet = vi.fn().mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        provider: "assemblyai",
        "assemblyai.apiKey": "test-api-key",
        "assemblyai.connectionTimeout": 3000,
        autoStopDelay: 10,
        listeningDelay: 500,
        autoSubmit: false,
      };
      return values[key];
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: mockGet,
    } as unknown as vscode.WorkspaceConfiguration);

    const config = getConfig();

    expect(config.provider).toBe("assemblyai");
    expect(config.assemblyaiApiKey).toBe("test-api-key");
    expect(config.assemblyaiConnectionTimeout).toBe(3000);
    expect(config.autoStopDelay).toBe(10);
    expect(config.listeningDelay).toBe(500);
    expect(config.autoSubmit).toBe(false);
  });

  it("clamps values to valid range", () => {
    const mockGet = vi.fn().mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        "assemblyai.connectionTimeout": 50000, // Over max (10000)
        autoStopDelay: 1, // Under min (3)
        listeningDelay: 50, // Under min (100)
      };
      return values[key];
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: mockGet,
    } as unknown as vscode.WorkspaceConfiguration);

    const config = getConfig();

    expect(config.assemblyaiConnectionTimeout).toBe(10000); // Clamped to max
    expect(config.autoStopDelay).toBe(3); // Clamped to min
    expect(config.listeningDelay).toBe(100); // Clamped to min
  });
});
