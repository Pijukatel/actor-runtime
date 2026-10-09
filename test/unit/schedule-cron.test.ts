import { describe, expect, it } from 'vitest';

import { assertValidCronExpression, computeNextRunAt, isSupportedTimezone } from '../../src/services/schedule-cron.js';

const NOW = new Date('2026-01-15T10:30:00.000Z');

describe('computeNextRunAt', () => {
	it('takes the next time of an explicit expression, in UTC by default', () => {
		expect(computeNextRunAt({ cronExpression: '0 12 * * *', currentDate: NOW }).toISOString()).toBe(
			'2026-01-15T12:00:00.000Z',
		);
		expect(computeNextRunAt({ cronExpression: '*/15 * * * *', currentDate: NOW }).toISOString()).toBe(
			'2026-01-15T10:45:00.000Z',
		);
	});

	it('evaluates the expression in the given timezone', () => {
		// January: New York is UTC-5.
		const next = computeNextRunAt({ cronExpression: '0 12 * * *', currentDate: NOW, timezone: 'America/New_York' });
		expect(next.toISOString()).toBe('2026-01-15T17:00:00.000Z');
	});

	it('spreads @daily by a fixed offset inside the day, never moving an offset run already due', () => {
		// 5 minutes + 0.5 * (6 hours - 5 minutes), rounded to 30 s: 3 h 02 m 30 s after midnight.
		const half = computeNextRunAt({ cronExpression: '@daily', randomOffsetCoeff: 0.5, currentDate: NOW });
		expect(half.toISOString()).toBe('2026-01-16T03:02:30.000Z');
		// With the day's offset run still ahead, it is the one picked, not tomorrow's.
		const early = new Date('2026-01-15T01:00:00.000Z');
		const today = computeNextRunAt({ cronExpression: '@daily', randomOffsetCoeff: 0.5, currentDate: early });
		expect(today.toISOString()).toBe('2026-01-15T03:02:30.000Z');
		const none = computeNextRunAt({ cronExpression: '@daily', randomOffsetCoeff: 0, currentDate: NOW });
		expect(none.toISOString()).toBe('2026-01-16T00:00:00.000Z');
	});

	it('keeps at least 10 seconds from the last run', () => {
		const everySecond = computeNextRunAt({
			cronExpression: '* * * * * *',
			currentDate: NOW,
			lastRunDate: new Date(NOW.getTime() - 1000),
		});
		expect(everySecond.getTime()).toBe(NOW.getTime() + 9000);
	});

	it('rejects an invalid expression or timezone', () => {
		expect(() => computeNextRunAt({ cronExpression: 'every day', currentDate: NOW })).toThrow();
		expect(() => assertValidCronExpression('0 0 * * 9')).toThrow();
		expect(() => assertValidCronExpression('@daily')).not.toThrow();
		expect(() =>
			computeNextRunAt({ cronExpression: '@daily', currentDate: NOW, timezone: 'Mars/Olympus' }),
		).toThrow(/unsupported value/);
		expect(isSupportedTimezone('Europe/Prague')).toBe(true);
		expect(isSupportedTimezone('UTC')).toBe(true);
		expect(isSupportedTimezone('Nowhere')).toBe(false);
	});
});
