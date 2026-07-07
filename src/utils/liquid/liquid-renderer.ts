import { Liquid } from "liquidjs";

const engine = new Liquid();

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return engine.parseAndRenderSync(template, data);
}

/**
 * True when `template` parses as valid Liquid (syntax only — does not evaluate
 * or check referenced fields). Used to validate an inline template before it is
 * saved, so a typo is caught in the settings dialog instead of silently failing
 * later at auto-workspace creation.
 */
export function isValidLiquidTemplate(template: string): boolean {
  try {
    engine.parse(template);
    return true;
  } catch {
    return false;
  }
}
