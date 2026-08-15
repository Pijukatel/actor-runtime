/**
 * Apify-style resource id generation.
 *
 * Real Apify ids are 17 characters drawn from an alphanumeric alphabet. We only need ids that are
 * unique within this single-process runtime, so `crypto.randomBytes` mapped onto the same alphabet
 * is enough - it also keeps every id URL-safe and free of characters that would need escaping.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 17;

export function generateId(): string {
	const bytes = randomBytes(ID_LENGTH);
	let id = '';
	for (let i = 0; i < ID_LENGTH; i++) {
		id += ALPHABET[bytes[i]! % ALPHABET.length];
	}
	return id;
}
