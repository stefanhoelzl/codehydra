import { describe, it, expect } from "vitest";
import type { DialogConfig } from "@shared/dialog-types";
import { dialogHeading } from "./dialog-heading.js";

describe("dialogHeading", () => {
  it("returns the first heading text section's content", () => {
    const config: DialogConfig = {
      sections: [
        { type: "text", content: "Body" },
        { type: "text", content: "Title", style: "heading" },
        { type: "text", content: "Second", style: "heading" },
      ],
    };
    expect(dialogHeading(config, "Dialog")).toBe("Title");
  });

  it("falls back without a heading section", () => {
    expect(dialogHeading({ sections: [{ type: "text", content: "Body" }] }, "Panel")).toBe("Panel");
  });

  it("falls back without a config (the teardown frame)", () => {
    expect(dialogHeading(undefined, "Panel")).toBe("Panel");
  });
});
