import { describe, it, expect, vi } from "vitest";
import {
  reconstructVscodeObjects,
  SUPPORTED_VSCODE_TYPES,
  type VscodeFactories,
} from "./vscode-serialization";

/**
 * Create mock factories that record calls and return identifiable mock objects.
 */
function createMockFactories() {
  const calls = {
    Uri: [] as Array<{ value: string }>,
    Position: [] as Array<{ line: number; character: number }>,
    Range: [] as Array<{ start: unknown; end: unknown }>,
    Selection: [] as Array<{ anchor: unknown; active: unknown }>,
    Location: [] as Array<{ uri: unknown; range: unknown }>,
  };

  const factories: VscodeFactories = {
    Uri: vi.fn((value: string) => {
      calls.Uri.push({ value });
      return { __mock: "Uri", value };
    }),
    Position: vi.fn((line: number, character: number) => {
      calls.Position.push({ line, character });
      return { __mock: "Position", line, character };
    }),
    Range: vi.fn((start: unknown, end: unknown) => {
      calls.Range.push({ start, end });
      return { __mock: "Range", start, end };
    }),
    Selection: vi.fn((anchor: unknown, active: unknown) => {
      calls.Selection.push({ anchor, active });
      return { __mock: "Selection", anchor, active };
    }),
    Location: vi.fn((uri: unknown, range: unknown) => {
      calls.Location.push({ uri, range });
      return { __mock: "Location", uri, range };
    }),
  };

  return { factories, calls };
}

describe("SUPPORTED_VSCODE_TYPES", () => {
  it("contains expected types", () => {
    expect(SUPPORTED_VSCODE_TYPES.has("Uri")).toBe(true);
    expect(SUPPORTED_VSCODE_TYPES.has("Position")).toBe(true);
    expect(SUPPORTED_VSCODE_TYPES.has("Range")).toBe(true);
    expect(SUPPORTED_VSCODE_TYPES.has("Selection")).toBe(true);
    expect(SUPPORTED_VSCODE_TYPES.has("Location")).toBe(true);
    expect(SUPPORTED_VSCODE_TYPES.size).toBe(5);
  });
});

describe("reconstructVscodeObjects", () => {
  // Test 1: Uri wrapper reconstruction
  it("reconstructs Uri wrapper", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects({ $vscode: "Uri", value: "file:///test" }, factories);

    expect(factories.Uri).toHaveBeenCalledWith("file:///test");
    expect(result).toEqual({ __mock: "Uri", value: "file:///test" });
  });

  // Test 2: Position wrapper reconstruction
  it("reconstructs Position wrapper", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      { $vscode: "Position", line: 0, character: 5 },
      factories
    );

    expect(factories.Position).toHaveBeenCalledWith(0, 5);
    expect(result).toEqual({ __mock: "Position", line: 0, character: 5 });
  });

  // Test 3: Range wrapper reconstruction
  it("reconstructs Range wrapper with nested Positions", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      {
        $vscode: "Range",
        start: { $vscode: "Position", line: 10, character: 5 },
        end: { $vscode: "Position", line: 10, character: 20 },
      },
      factories
    );

    expect(factories.Position).toHaveBeenCalledTimes(2);
    expect(factories.Position).toHaveBeenCalledWith(10, 5);
    expect(factories.Position).toHaveBeenCalledWith(10, 20);
    expect(factories.Range).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ __mock: "Range" });
  });

  // Test 4: Selection wrapper reconstruction
  it("reconstructs Selection wrapper with nested Positions", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      {
        $vscode: "Selection",
        anchor: { $vscode: "Position", line: 5, character: 0 },
        active: { $vscode: "Position", line: 10, character: 15 },
      },
      factories
    );

    expect(factories.Position).toHaveBeenCalledTimes(2);
    expect(factories.Selection).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ __mock: "Selection" });
  });

  // Test 5: Location wrapper reconstruction
  it("reconstructs Location wrapper with nested Uri and Range", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      {
        $vscode: "Location",
        uri: { $vscode: "Uri", value: "file:///path/to/file.ts" },
        range: {
          $vscode: "Range",
          start: { $vscode: "Position", line: 10, character: 5 },
          end: { $vscode: "Position", line: 10, character: 20 },
        },
      },
      factories
    );

    expect(factories.Uri).toHaveBeenCalledWith("file:///path/to/file.ts");
    expect(factories.Position).toHaveBeenCalledTimes(2);
    expect(factories.Range).toHaveBeenCalledTimes(1);
    expect(factories.Location).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ __mock: "Location" });
  });

  // Test 6: Nested wrappers in plain object
  it("reconstructs wrappers nested in plain objects", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      {
        label: "foo",
        uri: { $vscode: "Uri", value: "file:///test.ts" },
      },
      factories
    );

    expect(factories.Uri).toHaveBeenCalledWith("file:///test.ts");
    expect(result).toEqual({
      label: "foo",
      uri: { __mock: "Uri", value: "file:///test.ts" },
    });
  });

  // Test 7: Nested wrappers in array
  it("reconstructs wrappers nested in arrays", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      [{ $vscode: "Uri", value: "file:///test.ts" }, "plain"],
      factories
    );

    expect(factories.Uri).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ __mock: "Uri", value: "file:///test.ts" }, "plain"]);
  });

  // Test 8: Plain object passthrough
  it("passes through plain objects unchanged", () => {
    const { factories } = createMockFactories();
    const input = { foo: "bar", nested: { baz: 123 } };
    const result = reconstructVscodeObjects(input, factories);

    expect(factories.Uri).not.toHaveBeenCalled();
    expect(factories.Position).not.toHaveBeenCalled();
    expect(result).toEqual(input);
  });

  // Test 9: Plain array passthrough
  it("passes through plain arrays unchanged", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects([1, 2, 3], factories);

    expect(result).toEqual([1, 2, 3]);
  });

  // Test 10: Primitives passthrough
  it("passes through primitives unchanged", () => {
    const { factories } = createMockFactories();

    expect(reconstructVscodeObjects("string", factories)).toBe("string");
    expect(reconstructVscodeObjects(42, factories)).toBe(42);
    expect(reconstructVscodeObjects(true, factories)).toBe(true);
    expect(reconstructVscodeObjects(null, factories)).toBe(null);
    expect(reconstructVscodeObjects(undefined, factories)).toBe(undefined);
  });

  // Test 11: Unknown $vscode type error
  it("throws error for unknown $vscode type", () => {
    const { factories } = createMockFactories();

    expect(() => reconstructVscodeObjects({ $vscode: "Unknown" }, factories)).toThrow(
      'Unknown VS Code object type: "Unknown". Supported types: Uri, Position, Range, Selection, Location'
    );
  });

  // Test 12: Uri missing value error
  it("throws error when Uri missing value field", () => {
    const { factories } = createMockFactories();

    expect(() => reconstructVscodeObjects({ $vscode: "Uri" }, factories)).toThrow(
      'Invalid VS Code Uri: missing required field "value"'
    );
  });

  // Test 13: Position missing line error
  it("throws error when Position missing line field", () => {
    const { factories } = createMockFactories();

    expect(() =>
      reconstructVscodeObjects({ $vscode: "Position", character: 0 }, factories)
    ).toThrow('Invalid VS Code Position: missing required field "line"');
  });

  // Test 14: Position missing character error
  it("throws error when Position missing character field", () => {
    const { factories } = createMockFactories();

    expect(() => reconstructVscodeObjects({ $vscode: "Position", line: 0 }, factories)).toThrow(
      'Invalid VS Code Position: missing required field "character"'
    );
  });

  // Test 15: Position invalid line type error
  it("throws error when Position line is not a number", () => {
    const { factories } = createMockFactories();

    expect(() =>
      reconstructVscodeObjects({ $vscode: "Position", line: "0", character: 0 }, factories)
    ).toThrow('Invalid VS Code Position: field "line" must be a number, got string');
  });

  // Test 16: Range with invalid nested Position
  it("throws error for Range with invalid nested Position", () => {
    const { factories } = createMockFactories();

    expect(() =>
      reconstructVscodeObjects(
        {
          $vscode: "Range",
          start: { $vscode: "Position" }, // Missing fields
          end: { $vscode: "Position", line: 0, character: 0 },
        },
        factories
      )
    ).toThrow('Invalid VS Code Position: missing required field "line"');
  });

  // Test 17: Mixed object with primitives preserved
  it("preserves primitives in mixed objects", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      {
        label: "test",
        count: 5,
        enabled: true,
        uri: { $vscode: "Uri", value: "file:///test.ts" },
      },
      factories
    );

    expect(result).toEqual({
      label: "test",
      count: 5,
      enabled: true,
      uri: { __mock: "Uri", value: "file:///test.ts" },
    });
  });

  // Additional tests for completeness

  it("handles deeply nested arrays and objects", () => {
    const { factories } = createMockFactories();
    const result = reconstructVscodeObjects(
      {
        items: [
          {
            locations: [
              {
                $vscode: "Location",
                uri: { $vscode: "Uri", value: "file:///a.ts" },
                range: {
                  $vscode: "Range",
                  start: { $vscode: "Position", line: 1, character: 0 },
                  end: { $vscode: "Position", line: 1, character: 10 },
                },
              },
            ],
          },
        ],
      },
      factories
    );

    expect(factories.Uri).toHaveBeenCalledTimes(1);
    expect(factories.Position).toHaveBeenCalledTimes(2);
    expect(factories.Range).toHaveBeenCalledTimes(1);
    expect(factories.Location).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      items: [{ locations: [{ __mock: "Location" }] }],
    });
  });

  it("handles empty objects and arrays", () => {
    const { factories } = createMockFactories();

    expect(reconstructVscodeObjects({}, factories)).toEqual({});
    expect(reconstructVscodeObjects([], factories)).toEqual([]);
  });

  it("throws error for Range missing start field", () => {
    const { factories } = createMockFactories();

    expect(() =>
      reconstructVscodeObjects(
        { $vscode: "Range", end: { $vscode: "Position", line: 0, character: 0 } },
        factories
      )
    ).toThrow('Invalid VS Code Range: missing required field "start"');
  });

  it("throws error for Location missing uri field", () => {
    const { factories } = createMockFactories();

    expect(() =>
      reconstructVscodeObjects(
        {
          $vscode: "Location",
          range: {
            $vscode: "Range",
            start: { $vscode: "Position", line: 0, character: 0 },
            end: { $vscode: "Position", line: 0, character: 0 },
          },
        },
        factories
      )
    ).toThrow('Invalid VS Code Location: missing required field "uri"');
  });

  it("throws error for Selection missing anchor field", () => {
    const { factories } = createMockFactories();

    expect(() =>
      reconstructVscodeObjects(
        {
          $vscode: "Selection",
          active: { $vscode: "Position", line: 0, character: 0 },
        },
        factories
      )
    ).toThrow('Invalid VS Code Selection: missing required field "anchor"');
  });

  it("throws error for Uri with non-string value", () => {
    const { factories } = createMockFactories();

    expect(() => reconstructVscodeObjects({ $vscode: "Uri", value: 123 }, factories)).toThrow(
      'Invalid VS Code Uri: field "value" must be a string, got number'
    );
  });
});
