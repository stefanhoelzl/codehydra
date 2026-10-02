/**
 * The accessible name of a dialog surface: the content of its first heading
 * text section, else the surface's generic fallback ("Dialog", "Panel").
 */
import type { DialogConfig } from "@shared/dialog-types";

export function dialogHeading(config: DialogConfig | undefined, fallback: string): string {
  for (const section of config?.sections ?? []) {
    if (section.type === "text" && section.style === "heading") return section.content;
  }
  return fallback;
}
