/**
 * VS Code Object Serialization Utilities
 *
 * Provides serialization/deserialization for VS Code objects (Uri, Position, Range, etc.)
 * that cannot be transmitted directly through JSON. Objects are wrapped with a `$vscode`
 * type marker that identifies how to reconstruct them.
 *
 * The reconstruction function is pure TypeScript with injected factories, making it
 * testable without VS Code dependencies.
 */

/**
 * Supported VS Code object types.
 */
export const SUPPORTED_VSCODE_TYPES = new Set([
  "Uri",
  "Position",
  "Range",
  "Selection",
  "Location",
] as const);

/**
 * Type name for a supported VS Code object.
 */
export type VscodeTypeName = "Uri" | "Position" | "Range" | "Selection" | "Location";

/**
 * Wrapper format for Uri objects.
 */
export interface VscodeUriWrapper {
  readonly $vscode: "Uri";
  readonly value: string;
}

/**
 * Wrapper format for Position objects.
 */
export interface VscodePositionWrapper {
  readonly $vscode: "Position";
  readonly line: number;
  readonly character: number;
}

/**
 * Wrapper format for Range objects.
 */
export interface VscodeRangeWrapper {
  readonly $vscode: "Range";
  readonly start: VscodePositionWrapper;
  readonly end: VscodePositionWrapper;
}

/**
 * Wrapper format for Selection objects.
 */
export interface VscodeSelectionWrapper {
  readonly $vscode: "Selection";
  readonly anchor: VscodePositionWrapper;
  readonly active: VscodePositionWrapper;
}

/**
 * Wrapper format for Location objects.
 */
export interface VscodeLocationWrapper {
  readonly $vscode: "Location";
  readonly uri: VscodeUriWrapper;
  readonly range: VscodeRangeWrapper;
}

/**
 * Discriminated union of all VS Code wrapper types.
 */
export type VscodeWrapper =
  | VscodeUriWrapper
  | VscodePositionWrapper
  | VscodeRangeWrapper
  | VscodeSelectionWrapper
  | VscodeLocationWrapper;

/**
 * Factory functions for creating VS Code objects.
 *
 * Each factory receives the validated wrapper data and returns the actual VS Code object.
 * The Position/Range/Selection/Location factories receive already-reconstructed nested objects.
 */
export interface VscodeFactories {
  /**
   * Create a Uri from a string value.
   */
  Uri: (value: string) => unknown;

  /**
   * Create a Position from line and character numbers.
   */
  Position: (line: number, character: number) => unknown;

  /**
   * Create a Range from start and end Position objects.
   */
  Range: (start: unknown, end: unknown) => unknown;

  /**
   * Create a Selection from anchor and active Position objects.
   */
  Selection: (anchor: unknown, active: unknown) => unknown;

  /**
   * Create a Location from a Uri and Range object.
   */
  Location: (uri: unknown, range: unknown) => unknown;
}

/**
 * Check if a value is a VS Code wrapper object (has $vscode property).
 */
function isVscodeWrapper(value: unknown): value is { $vscode: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$vscode" in value &&
    typeof (value as { $vscode: unknown }).$vscode === "string"
  );
}

/**
 * Validate that a required field exists on the wrapper.
 */
function validateRequiredField(
  wrapper: Record<string, unknown>,
  typeName: string,
  fieldName: string
): void {
  if (!(fieldName in wrapper)) {
    throw new Error(`Invalid VS Code ${typeName}: missing required field "${fieldName}"`);
  }
}

/**
 * Validate that a field is a number.
 */
function validateNumberField(
  wrapper: Record<string, unknown>,
  typeName: string,
  fieldName: string
): void {
  const value = wrapper[fieldName];
  if (typeof value !== "number") {
    throw new Error(
      `Invalid VS Code ${typeName}: field "${fieldName}" must be a number, got ${typeof value}`
    );
  }
}

/**
 * Reconstruct VS Code objects from their JSON wrapper format.
 *
 * This function recursively processes a value, transforming any objects with a `$vscode`
 * marker into actual VS Code objects using the provided factory functions.
 *
 * @param value - The value to transform (may be nested objects/arrays)
 * @param factories - Factory functions for creating VS Code objects
 * @returns The value with all $vscode wrappers replaced with actual objects
 * @throws Error if an unknown $vscode type is encountered or required fields are missing
 */
export function reconstructVscodeObjects(value: unknown, factories: VscodeFactories): unknown {
  // Handle null/undefined/primitives - pass through unchanged
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  // Handle arrays - recursively process each element
  if (Array.isArray(value)) {
    return value.map((item) => reconstructVscodeObjects(item, factories));
  }

  // Handle objects
  const obj = value as Record<string, unknown>;

  // Check for $vscode marker
  if (isVscodeWrapper(obj)) {
    return reconstructSingleWrapper(obj, factories);
  }

  // Plain object - recursively process each property
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = reconstructVscodeObjects(obj[key], factories);
  }
  return result;
}

/**
 * Reconstruct a single VS Code wrapper object.
 */
function reconstructSingleWrapper(
  wrapper: { $vscode: string } & Record<string, unknown>,
  factories: VscodeFactories
): unknown {
  const typeName = wrapper.$vscode;

  // Check for supported type
  if (!SUPPORTED_VSCODE_TYPES.has(typeName as VscodeTypeName)) {
    const supportedList = Array.from(SUPPORTED_VSCODE_TYPES).join(", ");
    throw new Error(
      `Unknown VS Code object type: "${typeName}". Supported types: ${supportedList}`
    );
  }

  switch (typeName) {
    case "Uri":
      return reconstructUri(wrapper, factories);
    case "Position":
      return reconstructPosition(wrapper, factories);
    case "Range":
      return reconstructRange(wrapper, factories);
    case "Selection":
      return reconstructSelection(wrapper, factories);
    case "Location":
      return reconstructLocation(wrapper, factories);
    default:
      // This should never happen due to the SUPPORTED_VSCODE_TYPES check above
      throw new Error(`Unhandled VS Code type: ${typeName}`);
  }
}

/**
 * Reconstruct a Uri wrapper.
 */
function reconstructUri(wrapper: Record<string, unknown>, factories: VscodeFactories): unknown {
  validateRequiredField(wrapper, "Uri", "value");
  const value = wrapper.value;
  if (typeof value !== "string") {
    throw new Error(`Invalid VS Code Uri: field "value" must be a string, got ${typeof value}`);
  }
  return factories.Uri(value);
}

/**
 * Reconstruct a Position wrapper.
 */
function reconstructPosition(
  wrapper: Record<string, unknown>,
  factories: VscodeFactories
): unknown {
  validateRequiredField(wrapper, "Position", "line");
  validateRequiredField(wrapper, "Position", "character");
  validateNumberField(wrapper, "Position", "line");
  validateNumberField(wrapper, "Position", "character");

  return factories.Position(wrapper.line as number, wrapper.character as number);
}

/**
 * Reconstruct a Range wrapper.
 */
function reconstructRange(wrapper: Record<string, unknown>, factories: VscodeFactories): unknown {
  validateRequiredField(wrapper, "Range", "start");
  validateRequiredField(wrapper, "Range", "end");

  // Recursively reconstruct nested Position objects
  const start = reconstructVscodeObjects(wrapper.start, factories);
  const end = reconstructVscodeObjects(wrapper.end, factories);

  return factories.Range(start, end);
}

/**
 * Reconstruct a Selection wrapper.
 */
function reconstructSelection(
  wrapper: Record<string, unknown>,
  factories: VscodeFactories
): unknown {
  validateRequiredField(wrapper, "Selection", "anchor");
  validateRequiredField(wrapper, "Selection", "active");

  // Recursively reconstruct nested Position objects
  const anchor = reconstructVscodeObjects(wrapper.anchor, factories);
  const active = reconstructVscodeObjects(wrapper.active, factories);

  return factories.Selection(anchor, active);
}

/**
 * Reconstruct a Location wrapper.
 */
function reconstructLocation(
  wrapper: Record<string, unknown>,
  factories: VscodeFactories
): unknown {
  validateRequiredField(wrapper, "Location", "uri");
  validateRequiredField(wrapper, "Location", "range");

  // Recursively reconstruct nested Uri and Range objects
  const uri = reconstructVscodeObjects(wrapper.uri, factories);
  const range = reconstructVscodeObjects(wrapper.range, factories);

  return factories.Location(uri, range);
}
