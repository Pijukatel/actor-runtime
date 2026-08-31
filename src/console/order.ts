/**
 * Tiebreak for every builds/runs list: `Registry.list()` documents "no particular order" of its own
 * (`storage/registry.ts`), so two records sharing a `startedAt` could otherwise swap position between
 * renders; `id` (unique per record) breaks the tie the same way every time.
 *
 * Not a reuse of the API's `sortByTimestamp` (`api/envelope.ts`): that helper sorts ascending where this
 * sorts descending, and reusing it would make the console layer depend on the API layer - the two are
 * sibling consumers of `services/`, neither of the other.
 */
export function newestFirst<T extends { id: string; startedAt: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}
