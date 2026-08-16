import { CONSOLE_BASE_URL } from '../../config.js';
import type { StorageRecord } from '../../storage/entities.js';

/** The zeroed `stats` shape every storage type reports (`storage.md`'s documented simplification). */
export function zeroedStats(): Record<string, number> {
	return { readCount: 0, writeCount: 0, deleteCount: 0 };
}

export function datasetDto(
	record: StorageRecord,
	info: { createdAt: Date; modifiedAt: Date; accessedAt: Date; itemCount: number },
) {
	return {
		id: record.id,
		name: record.name,
		userId: record.userId,
		createdAt: info.createdAt.toISOString(),
		modifiedAt: info.modifiedAt.toISOString(),
		accessedAt: info.accessedAt.toISOString(),
		itemCount: info.itemCount,
		cleanItemCount: info.itemCount,
		// Required by the real Apify API contract (`apify-client`'s `Dataset` pydantic model has no
		// default for `consoleUrl`) - points at this runtime's own console, not `console.apify.com`.
		consoleUrl: `${CONSOLE_BASE_URL}/datasets/${record.id}`,
		stats: { ...zeroedStats(), storageBytes: 0 },
	};
}

export function keyValueStoreDto(record: StorageRecord) {
	return {
		id: record.id,
		name: record.name,
		userId: record.userId,
		createdAt: record.createdAt,
		modifiedAt: record.modifiedAt,
		accessedAt: record.accessedAt,
		// Optional on the real contract (`apify-client`'s `KeyValueStore` pydantic model defaults
		// `consoleUrl` to `None`), included anyway for parity with the dataset/request-queue DTOs above
		// and below, which the real platform also always populates.
		consoleUrl: `${CONSOLE_BASE_URL}/key-value-stores/${record.id}`,
		stats: { ...zeroedStats(), storageBytes: 0 },
	};
}

export function requestQueueDto(
	record: StorageRecord,
	info: {
		createdAt: Date;
		modifiedAt: Date;
		accessedAt: Date;
		totalRequestCount: number;
		handledRequestCount: number;
		pendingRequestCount: number;
	},
) {
	return {
		id: record.id,
		name: record.name,
		userId: record.userId,
		createdAt: info.createdAt.toISOString(),
		modifiedAt: info.modifiedAt.toISOString(),
		accessedAt: info.accessedAt.toISOString(),
		totalRequestCount: info.totalRequestCount,
		handledRequestCount: info.handledRequestCount,
		pendingRequestCount: info.pendingRequestCount,
		hadMultipleClients: false,
		// Required by the real Apify API contract (`apify-client`'s `RequestQueue` pydantic model has no
		// default for `consoleUrl`) - points at this runtime's own console, not `console.apify.com`.
		consoleUrl: `${CONSOLE_BASE_URL}/request-queues/${record.id}`,
		stats: zeroedStats(),
	};
}
