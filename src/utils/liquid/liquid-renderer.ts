import { Liquid } from "liquidjs";

const engine = new Liquid();

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return engine.parseAndRenderSync(template, data);
}
