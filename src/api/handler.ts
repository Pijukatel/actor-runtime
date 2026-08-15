import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { invalidRequest } from './errors.js';
import type { PaginationOptions } from './envelope.js';

/** Wraps an async Express handler so a thrown/rejected error reaches the error middleware. */
export function h(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		fn(req, res).catch(next);
	};
}

/** The whole app uses `express.raw({ type: () => true })`, so every body arrives as a `Buffer`. */
export function rawBody(req: Request): Buffer {
	if (Buffer.isBuffer(req.body)) return req.body;
	return Buffer.alloc(0);
}

export function jsonBody<T = unknown>(req: Request): T {
	const buffer = rawBody(req);
	if (buffer.length === 0) throw invalidRequest('Request body must be valid JSON');
	try {
		return JSON.parse(buffer.toString('utf8')) as T;
	} catch {
		throw invalidRequest('Request body must be valid JSON');
	}
}

export function optionalJsonBody<T = unknown>(req: Request): T | undefined {
	const buffer = rawBody(req);
	if (buffer.length === 0) return undefined;
	return jsonBody<T>(req);
}

export function queryString(req: Request, key: string): string | undefined {
	const value = req.query[key];
	return typeof value === 'string' ? value : undefined;
}

export function queryNumber(req: Request, key: string): number | undefined {
	const value = queryString(req, key);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function queryBoolean(req: Request, key: string): boolean | undefined {
	const value = queryString(req, key);
	if (value === undefined) return undefined;
	return value === 'true' || value === '1';
}

export function toNodeBuffer(value: Buffer | ArrayBuffer): Buffer {
	return Buffer.isBuffer(value) ? value : Buffer.from(new Uint8Array(value));
}

export function queryList(req: Request, key: string): string[] | undefined {
	const value = queryString(req, key);
	if (value === undefined) return undefined;
	return value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** The `limit`/`offset`/`desc` query params every collection endpoint accepts, parsed once for
 * `envelope.ts`'s `paginate`/`sendPaginated`. */
export function paginationParams(req: Request): PaginationOptions {
	return {
		offset: queryNumber(req, 'offset'),
		limit: queryNumber(req, 'limit'),
		desc: queryBoolean(req, 'desc'),
	};
}
