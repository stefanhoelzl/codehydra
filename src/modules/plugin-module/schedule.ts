/**
 * An automation's `schedule`: a standard 5-field cron expression, in the
 * machine's local time.
 *
 * Exactly 5 fields: cron-parser would also take a sixth for seconds and aliases
 * like `@daily`, and seconds would promise more than a poll can keep. A schedule
 * can only make an automation run less often than `poll.interval`.
 */

import { CronExpressionParser } from "cron-parser";
import { getErrorMessage } from "../../shared/error-utils";

/** Why an expression is not a schedule; undefined when it is one. */
export function scheduleProblem(expression: string): string | undefined {
  if (expression.trim().split(/\s+/).length !== 5) {
    return "a schedule has 5 fields: minute hour day-of-month month day-of-week";
  }
  try {
    CronExpressionParser.parse(expression);
    return undefined;
  } catch (error) {
    return getErrorMessage(error);
  }
}

/** The first time the schedule names after `after`. */
export function nextScheduled(expression: string, after: number): number {
  return CronExpressionParser.parse(expression, { currentDate: new Date(after) })
    .next()
    .getTime();
}

/** Whether the schedule names a time after `since` that has passed by `now`. */
export function isDue(expression: string, since: number, now: number): boolean {
  return nextScheduled(expression, since) <= now;
}
