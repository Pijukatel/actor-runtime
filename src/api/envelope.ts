import type { Response } from 'express';

/** Wraps every JSON payload as `{ "data": ... }` - apify-client-js unwraps every response via its
 * internal `pluckData` and will otherwise hand the CLI `undefined`. */
export function sendData(res: Response, data: unknown, status = 200): void {
	res.status(status).json({ data });
}

export function sendError(res: Response, status: number, type: string, message: string): void {
	res.status(status).json({ error: { type, message } });
}

export interface PaginationOptions {
	offset?: number;
	limit?: number;
	desc?: boolean;
}

export interface PaginatedEnvelope<T> {
	total: number;
	count: number;
	offset: number;
	limit: number;
	desc: boolean;
	items: T[];
}

/**
 * The `{ total, count, offset, limit, desc, items }` list envelope every collection endpoint returns
 * (real Apify API pagination contract) - the one place this shape is computed, so every route builds it
 * identically instead of re-deriving it inline. `itemsInNaturalOrder` must already be in ascending
 * natural order (stable - insertion order for a plain array like `ActorRecord.versions`, or sorted by a
 * timestamp field by the caller for a `Registry.list()` result, which has no order guarantee of its
 * own); this function only reverses (`desc`) and slices (`offset`/`limit`). `total` is measured before
 * the slice, `count` after.
 */
export function paginate<T>(itemsInNaturalOrder: readonly T[], options: PaginationOptions): PaginatedEnvelope<T> {
	const desc = options.desc ?? false;
	const offset = options.offset ?? 0;
	const limit = options.limit ?? itemsInNaturalOrder.length;
	const ordered = desc ? [...itemsInNaturalOrder].reverse() : itemsInNaturalOrder;
	const items = ordered.slice(offset, offset + limit);
	return { total: itemsInNaturalOrder.length, count: items.length, offset, limit, desc, items };
}

/** `paginate` + `sendData` in one call, for the common case where the paginated items are also the
 * final response payload (no further per-item async mapping needed). */
export function sendPaginated<T>(res: Response, itemsInNaturalOrder: readonly T[], options: PaginationOptions): void {
	sendData(res, paginate(itemsInNaturalOrder, options));
}

/** Ascending sort by an ISO-8601 timestamp field - the "sorted by createdAt" half of the natural order
 * `paginate` requires for a `Registry.list()` result (whose own iteration order is unspecified). */
export function sortByTimestamp<T>(items: readonly T[], timestampOf: (item: T) => string): T[] {
	return [...items].sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
}
