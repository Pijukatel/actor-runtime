/**
 * When a schedule next runs, after apify-core's `computeNextRunForCronExpression`: the cron expression's
 * next time in the schedule's timezone, spread by a per-schedule random offset for the `@hourly`-style
 * shortcuts, and never within 10 seconds of the last run.
 */
import { CronExpressionParser } from 'cron-parser';

interface RandomOffsetBounds {
	minSecs: number;
	maxSecs: number;
	roundSecs: number;
}

/** The platform's `CRON_RANDOM_OFFSET_BOUNDS`: offsets stay inside the expression's period. */
const CRON_RANDOM_OFFSET_BOUNDS: Record<string, RandomOffsetBounds> = {
	'@hourly': { minSecs: 1 * 60, maxSecs: 30 * 60, roundSecs: 10 },
	'@daily': { minSecs: 5 * 60, maxSecs: 6 * 3600, roundSecs: 30 },
	'@weekly': { minSecs: 5 * 60, maxSecs: 12 * 3600, roundSecs: 60 },
	'@monthly': { minSecs: 5 * 60, maxSecs: 24 * 3600, roundSecs: 10 * 60 },
	'@yearly': { minSecs: 5 * 60, maxSecs: 24 * 3600, roundSecs: 10 * 60 },
};

const MIN_INTERVAL_BETWEEN_RUNS_SECS = 10;

export interface NextRunOptions {
	cronExpression: string;
	/** Between 0 and 1; `0` or absent means no offset. */
	randomOffsetCoeff?: number;
	currentDate: Date;
	lastRunDate?: Date | null;
	timezone?: string;
}

/** A timezone `Intl` knows, which is what the cron library evaluates the expression in. */
export function isSupportedTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

/** Throws (with the parser's own message) for an expression the cron library does not accept. */
export function assertValidCronExpression(cronExpression: string): void {
	CronExpressionParser.parse(cronExpression);
}

/** The earliest run time at or after `currentDate`; throws for an invalid expression or timezone. */
export function computeNextRunAt(options: NextRunOptions): Date {
	const { cronExpression, randomOffsetCoeff = 0, currentDate, lastRunDate, timezone = 'UTC' } = options;
	if (!isSupportedTimezone(timezone))
		throw new Error(`The "timezone" parameter contains unsupported value "${timezone}"`);
	const interval = CronExpressionParser.parse(cronExpression, { currentDate, tz: timezone });

	let offsetSecs = 0;
	const bound = CRON_RANDOM_OFFSET_BOUNDS[cronExpression];
	if (bound && randomOffsetCoeff > 0) {
		offsetSecs = Math.round(bound.minSecs + randomOffsetCoeff * (bound.maxSecs - bound.minSecs));
		offsetSecs = Math.round(offsetSecs / bound.roundSecs) * bound.roundSecs;
	}

	for (let i = 0; i <= MIN_INTERVAL_BETWEEN_RUNS_SECS; i++) {
		// With an offset, the previous cron time plus the offset may still be ahead of now.
		let nextRunAt = i === 0 && offsetSecs > 0 ? interval.prev().toDate() : interval.next().toDate();
		if (offsetSecs > 0) nextRunAt = new Date(nextRunAt.getTime() + offsetSecs * 1000);
		if (
			nextRunAt >= currentDate &&
			(!lastRunDate || nextRunAt.getTime() - lastRunDate.getTime() >= MIN_INTERVAL_BETWEEN_RUNS_SECS * 1000)
		) {
			return nextRunAt;
		}
	}
	throw new Error('Cannot compute next run time');
}
