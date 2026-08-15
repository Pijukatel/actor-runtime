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
		stats: zeroedStats(),
	};
}
