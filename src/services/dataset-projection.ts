/**
 * Pure post-processing applied by the API layer over a dataset page. The fs dataset backend warns and
 * ignores everything except `offset`/`limit`/`desc` - it is on us to apply `fields`/`omit`/`clean`/
 * `skipHidden`/`skipEmpty`/`unwind` ourselves, over the already-paged items (so `total` reflects
 * unfiltered item count, a documented simplification).
 */
export type DatasetItem = Record<string, unknown>;

export interface DatasetProjectionOptions {
	fields?: string[];
	omit?: string[];
	unwind?: string;
	clean?: boolean;
	skipHidden?: boolean;
	skipEmpty?: boolean;
}

function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined || value === '') return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value as object).length === 0;
	return false;
}

function unwindItem(item: DatasetItem, field: string): DatasetItem[] {
	const value = item[field];
	if (!Array.isArray(value) || value.length === 0) return [item];
	return value.map((element) => ({ ...item, [field]: element }));
}

function projectItem(item: DatasetItem, options: DatasetProjectionOptions): DatasetItem {
	const skipHidden = Boolean(options.clean || options.skipHidden);
	const skipEmpty = Boolean(options.clean || options.skipEmpty);
	const keys = options.fields && options.fields.length > 0 ? options.fields : Object.keys(item);

	const result: DatasetItem = {};
	for (const key of keys) {
		if (options.omit?.includes(key)) continue;
		if (skipHidden && key.startsWith('#')) continue;
		if (!(key in item)) continue;
		const value = item[key];
		if (skipEmpty && isEmptyValue(value)) continue;
		result[key] = value;
	}
	return result;
}

export function applyDatasetProjection(items: DatasetItem[], options: DatasetProjectionOptions): DatasetItem[] {
	let working = items;
	if (options.unwind) {
		working = working.flatMap((item) => unwindItem(item, options.unwind as string));
	}
	return working.map((item) => projectItem(item, options));
}
