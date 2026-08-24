/**
 * Newest-`startedAt`-first order for every console view that lists builds and/or runs (`console.md`).
 * `Registry.list()` - what `listAllBuilds`/`listAllRuns` (`server.ts`) read through - documents its own
 * iteration as having "no particular order" (`storage/registry.ts`), so two records sharing the same
 * `startedAt` cannot rely on input order to stay put across renders; `id` (unique per record) breaks the
 * tie the same way every time, regardless of the order the registry happened to hand them back in.
 *
 * Deliberately its own module, not a reuse of the API's `sortByTimestamp` (`api/envelope.ts`): that
 * helper sorts ascending, for a different shape of data (already-paginated DTOs, reversed afterwards by
 * `paginate`'s own `desc` handling), and reaching for it here would make the console depend on the API
 * layer - the two are sibling consumers of `services/`, neither of the other. This two-line comparator is
 * cheap enough to keep that boundary intact, and small enough to unit-test on its own (see
 * `ansi.ts`/`ansi.test.ts` for the same pattern: a pure console-layer helper, tested directly).
 */
export function newestFirst<T extends { id: string; startedAt: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}
