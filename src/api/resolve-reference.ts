/**
 * The one place a route parameter becomes a record. Callers turn `null` into `record-not-found`, which
 * is what keeps an unresolvable reference eligible for the upstream fallback; an empty name is the
 * platform's own `400 invalid-request` and is never relayed.
 */
import type { Request } from 'express';

import type { ActorRecord, StorageRecord, StorageType, TaskRecord } from '../storage/entities.js';
import { parseResourceReference, type ResolvableReference } from '../services/resource-reference.js';
import { resolveOwnedActor } from '../services/actors.js';
import { resolveOwnedStorage } from '../services/storages.js';
import { resolveOwnedTask } from '../services/tasks.js';
import { requireUser } from './auth.js';
import { invalidRequest } from './errors.js';

function referenceFrom(req: Request, param: string): ResolvableReference {
	const reference = parseResourceReference(req.params[param] as string);
	if (reference.kind === 'empty-name') throw invalidRequest('Resource name parameter cannot be empty');
	return reference;
}

export async function resolveActorParam(req: Request): Promise<ActorRecord | null> {
	return resolveOwnedActor(requireUser(req), referenceFrom(req, 'actorId'));
}

export async function resolveStorageParam(
	req: Request,
	param: 'datasetId' | 'storeId' | 'queueId',
	type: StorageType,
): Promise<StorageRecord | null> {
	return resolveOwnedStorage(requireUser(req), referenceFrom(req, param), type);
}

export async function resolveTaskParam(req: Request): Promise<TaskRecord | null> {
	return resolveOwnedTask(requireUser(req), referenceFrom(req, 'actorTaskId'));
}
