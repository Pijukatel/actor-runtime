/**
 * The KV key-listing cursor: sort lexicographically (the only order `forEachKey` doesn't already
 * guarantee across backends), apply `exclusiveStartKey`, then `limit`.
 */
export interface KeyWithSize {
	key: string;
	size: number;
}

export interface KeyListingOptions {
	exclusiveStartKey?: string;
	limit?: number;
}

export interface KeyListingPage {
	items: KeyWithSize[];
	count: number;
	limit: number;
	exclusiveStartKey?: string;
	isTruncated: boolean;
	nextExclusiveStartKey?: string;
}

const DEFAULT_LIMIT = 1000;

export function pageKeys(allKeys: KeyWithSize[], options: KeyListingOptions = {}): KeyListingPage {
	const sorted = [...allKeys].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	let startIndex = 0;
	if (options.exclusiveStartKey !== undefined) {
		const idx = sorted.findIndex((k) => k.key > (options.exclusiveStartKey as string));
		startIndex = idx === -1 ? sorted.length : idx;
	}

	const limit = options.limit ?? DEFAULT_LIMIT;
	const page = sorted.slice(startIndex, startIndex + limit);
	const isTruncated = startIndex + page.length < sorted.length;

	return {
		items: page,
		count: page.length,
		limit,
		exclusiveStartKey: options.exclusiveStartKey,
		isTruncated,
		nextExclusiveStartKey: isTruncated ? page[page.length - 1]?.key : undefined,
	};
}
