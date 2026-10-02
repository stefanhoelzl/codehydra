import { describe, it, expect } from "vitest";
import { freshPush, reconcileField, suggestionLabel, type FieldState } from "./reconcile-field";
import type {
  CheckboxSectionConfig,
  DropdownSectionConfig,
  InputSectionConfig,
  RadioSectionConfig,
} from "./types";

const FIRST_SIGHT: FieldState = { value: undefined, display: undefined };

function held(value: string, display?: string): FieldState {
  return { value, display };
}

function radio(...ids: string[]): RadioSectionConfig {
  return {
    type: "radio",
    id: "r",
    options: ids.map((id) => ({ id, label: id.toUpperCase() })),
  };
}

function dropdown(
  values: string[],
  extra: Partial<Omit<DropdownSectionConfig, "type" | "id" | "suggestions">> = {}
): DropdownSectionConfig {
  return {
    type: "dropdown",
    id: "d",
    suggestions: [{ items: values.map((value) => ({ value, label: `label-${value}` })) }],
    ...extra,
  };
}

function input(extra: Partial<Omit<InputSectionConfig, "type" | "id">> = {}): InputSectionConfig {
  return { type: "input", id: "i", ...extra };
}

function checkbox(value?: boolean): CheckboxSectionConfig {
  return { type: "checkbox", id: "c", ...(value === undefined ? {} : { value }) };
}

describe("freshPush", () => {
  it("returns a pushed value that differs from the adopted one", () => {
    expect(freshPush("a", undefined)).toBe("a");
    expect(freshPush("b", "a")).toBe("b");
  });

  it("treats a re-send of the adopted value as no push", () => {
    expect(freshPush("a", "a")).toBeUndefined();
  });

  it("returns undefined when nothing was pushed", () => {
    expect(freshPush(undefined, "a")).toBeUndefined();
  });
});

describe("suggestionLabel", () => {
  it("returns the matching suggestion's label, else the value", () => {
    const section = dropdown(["x"]);
    expect(suggestionLabel(section, "x")).toBe("label-x");
    expect(suggestionLabel(section, "typed")).toBe("typed");
  });
});

describe("reconcileField", () => {
  describe("radio", () => {
    it("starts at the first option", () => {
      expect(reconcileField(radio("a", "b"), FIRST_SIGHT, undefined)).toEqual({ value: "a" });
    });

    it("keeps a still-valid choice", () => {
      expect(reconcileField(radio("a", "b"), held("b"), undefined)).toEqual({ value: "b" });
    });

    it("falls back to the first option when the choice vanished", () => {
      expect(reconcileField(radio("a", "c"), held("b"), undefined)).toEqual({ value: "a" });
    });

    it("is empty with no options", () => {
      expect(reconcileField(radio(), FIRST_SIGHT, undefined)).toEqual({ value: "" });
    });
  });

  describe("input", () => {
    it("seeds from initialValue on first sight", () => {
      expect(reconcileField(input({ initialValue: "seed" }), FIRST_SIGHT, undefined)).toEqual({
        value: "seed",
      });
    });

    it("keeps the user's edit over a later initialValue", () => {
      expect(reconcileField(input({ initialValue: "seed" }), held("edit"), undefined)).toEqual({
        value: "edit",
      });
    });

    it("adopts a fresh push over the user's edit", () => {
      expect(reconcileField(input({ value: "reset" }), held("edit"), undefined)).toEqual({
        value: "reset",
        adopt: "reset",
      });
    });

    it("keeps the user's edit on a re-send", () => {
      expect(reconcileField(input({ value: "reset" }), held("edit"), "reset")).toEqual({
        value: "edit",
      });
    });
  });

  describe("checkbox", () => {
    it("starts unchecked", () => {
      expect(reconcileField(checkbox(), FIRST_SIGHT, undefined)).toEqual({ value: "false" });
    });

    it("adopts a fresh push as a string", () => {
      expect(reconcileField(checkbox(true), held("false"), undefined)).toEqual({
        value: "true",
        adopt: "true",
      });
    });

    it("keeps the user's toggle on a re-send", () => {
      expect(reconcileField(checkbox(true), held("false"), "true")).toEqual({ value: "false" });
    });
  });

  describe("free-text dropdown", () => {
    it("seeds from initialValue and displays its label", () => {
      const section = dropdown(["x"], { freeText: true, initialValue: "x" });
      expect(reconcileField(section, FIRST_SIGHT, undefined)).toEqual({
        value: "x",
        display: "label-x",
      });
    });

    it("keeps typed text and what the user sees", () => {
      const section = dropdown(["x"], { freeText: true });
      expect(reconcileField(section, held("typ", "typ"), undefined)).toEqual({
        value: "typ",
        display: "typ",
      });
    });

    it("adopts any fresh push, even one naming no suggestion", () => {
      const section = dropdown(["x"], { freeText: true, value: "other" });
      expect(reconcileField(section, held("typ", "typ"), undefined)).toEqual({
        value: "other",
        display: "other",
        adopt: "other",
      });
    });
  });

  describe("strict dropdown", () => {
    it("starts at a valid initialValue", () => {
      const section = dropdown(["a", "b"], { initialValue: "b" });
      expect(reconcileField(section, FIRST_SIGHT, undefined)).toEqual({
        value: "b",
        display: "label-b",
      });
    });

    it("starts at the first suggestion when initialValue names none", () => {
      const section = dropdown(["a", "b"], { initialValue: "z" });
      expect(reconcileField(section, FIRST_SIGHT, undefined).value).toBe("a");
    });

    it("accepts any seed while the suggestion list is empty", () => {
      const section = dropdown([], { initialValue: "z" });
      expect(reconcileField(section, FIRST_SIGHT, undefined)).toEqual({ value: "z", display: "z" });
    });

    it("re-validates a seed once the list arrives", () => {
      expect(reconcileField(dropdown(["a"]), held("z", "z"), undefined)).toEqual({
        value: "a",
        display: "label-a",
      });
    });

    it("does not use initialValue once the field has a value", () => {
      const section = dropdown(["a", "b"], { initialValue: "b" });
      expect(reconcileField(section, held("a", "label-a"), undefined).value).toBe("a");
    });

    it("keeps a valid choice and its display", () => {
      expect(reconcileField(dropdown(["a", "b"]), held("b", "shown"), undefined)).toEqual({
        value: "b",
        display: "shown",
      });
    });

    it("adopts a valid fresh push and relabels", () => {
      const section = dropdown(["a", "b"], { value: "b" });
      expect(reconcileField(section, held("a", "label-a"), undefined)).toEqual({
        value: "b",
        display: "label-b",
        adopt: "b",
      });
    });

    it("relabels when a push re-selects the held value", () => {
      const section = dropdown(["a"], { value: "a" });
      expect(reconcileField(section, held("a", "typed"), undefined)).toEqual({
        value: "a",
        display: "label-a",
        adopt: "a",
      });
    });

    it("falls back without adopting a push that names no suggestion", () => {
      const section = dropdown(["a", "b"], { value: "z" });
      expect(reconcileField(section, held("b", "label-b"), undefined)).toEqual({
        value: "a",
        display: "label-a",
      });
    });

    it("adopts a previously rejected push once it becomes valid", () => {
      const section = dropdown(["a", "z"], { value: "z" });
      expect(reconcileField(section, held("a", "label-a"), undefined).adopt).toBe("z");
    });

    it("keeps the user's choice on a re-send", () => {
      const section = dropdown(["a", "b"], { value: "b" });
      expect(reconcileField(section, held("a", "label-a"), "b")).toEqual({
        value: "a",
        display: "label-a",
      });
    });
  });
});
