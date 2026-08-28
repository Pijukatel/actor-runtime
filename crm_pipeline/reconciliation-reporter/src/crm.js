/**
 * Shared CRM parsing / normalization rules for the nightly import pipeline.
 *
 * This file is the single source of truth for "what a correct pipeline does with a row".
 * It is copied verbatim into every Actor that needs it (`crm_pipeline/sync-shared.sh`),
 * because each Actor is pushed to the platform as a self-contained source folder.
 */

export const COLUMNS = ['id', 'name', 'email', 'phone', 'updatedAt', 'region'];
export const HEADER = COLUMNS.join(',');

/** Every reason a row can be quarantined for, in the order they are checked. */
export const QUARANTINE_REASONS = [
	'malformed_row',
	'missing_id',
	'invalid_email',
	'invalid_phone',
	'invalid_date',
	'invalid_region',
];

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function csvEscape(value) {
	const text = value === null || value === undefined ? '' : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC4180-ish single-line field splitter: honours double quotes and doubled escapes. */
export function splitCsvLine(line) {
	const fields = [];
	let current = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ',') {
			fields.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	fields.push(current);
	return fields;
}

/**
 * Splits a CSV export into data rows. The first line is always treated as the header.
 * `rowNumber` is the 1-based index of the data row (the header is not counted).
 */
export function parseCsvText(text) {
	const lines = String(text).split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	const header = lines.shift() ?? '';
	const rows = lines.map((raw, index) => ({ rowNumber: index + 1, raw, fields: splitCsvLine(raw) }));
	return { header, rows };
}

export function normalizeEmail(raw) {
	if (raw === null || raw === undefined) return null;
	const value = String(raw)
		.trim()
		.replace(/^[<'"\s]+/, '')
		.replace(/[>'"\s]+$/, '')
		.toLowerCase();
	return EMAIL_RE.test(value) ? value : null;
}

/**
 * Phone numbers are normalized to `+<digits>`:
 * an explicit `+` or `00` prefix keeps its own country code, a bare 9-digit
 * national number gets the +420 (Czech) prefix.
 */
export function normalizePhone(raw) {
	if (raw === null || raw === undefined) return null;
	const value = String(raw).trim();
	const hasPlus = value.startsWith('+');
	let digits = value.replace(/\D/g, '');
	if (!digits) return null;
	if (!hasPlus) {
		if (digits.startsWith('00')) digits = digits.slice(2);
		else if (digits.length === 9) digits = `420${digits}`;
	}
	if (digits.length < 9 || digits.length > 15) return null;
	return `+${digits}`;
}

function utcIso(year, month, day, hour = 0, minute = 0, second = 0) {
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const stamp = Date.UTC(year, month - 1, day, hour, minute, second);
	if (Number.isNaN(stamp)) return null;
	const date = new Date(stamp);
	// Rejects overflowing days such as 31.02.2024, which Date.UTC would silently roll over.
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.toISOString();
}

const num = (value, fallback = 0) => (value === undefined ? fallback : Number.parseInt(value, 10));

/** Accepts every date format the regional exports are known to use; returns ISO 8601 or null. */
export function normalizeDate(raw) {
	const value = String(raw ?? '').trim();
	if (!value) return null;

	let match;
	// Unix epoch, seconds or milliseconds.
	if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString();
	if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString();
	// Full ISO 8601 with an explicit zone.
	if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
		const stamp = Date.parse(value.replace(' ', 'T'));
		return Number.isNaN(stamp) ? null : new Date(stamp).toISOString();
	}
	// Zone-less timestamps are read as UTC.
	if ((match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value))) {
		return utcIso(num(match[1]), num(match[2]), num(match[3]), num(match[4]), num(match[5]), num(match[6]));
	}
	if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value))) {
		return utcIso(num(match[1]), num(match[2]), num(match[3]));
	}
	// Czech/European day-first formats.
	if ((match = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value))) {
		return utcIso(num(match[3]), num(match[2]), num(match[1]), num(match[4]), num(match[5]), num(match[6]));
	}
	if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value))) {
		return utcIso(num(match[3]), num(match[2]), num(match[1]), num(match[4]), num(match[5]), num(match[6]));
	}
	return null;
}

export function normalizeName(raw) {
	const value = String(raw ?? '')
		.trim()
		.replace(/\s+/g, ' ');
	const match = /^([^,]+),\s*(.+)$/.exec(value);
	return match ? `${match[2]} ${match[1]}` : value;
}

/**
 * Turns one raw CSV row into a normalized contact, or names the reason it must be quarantined.
 * Both the importer and the simulator's ground-truth pass go through this exact function.
 */
export function normalizeRow(fields) {
	if (!Array.isArray(fields) || fields.length !== COLUMNS.length) {
		return { ok: false, reason: 'malformed_row' };
	}
	const [id, name, email, phone, updatedAt, region] = fields.map((field) => String(field ?? '').trim());
	if (!id) return { ok: false, reason: 'missing_id' };
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) return { ok: false, reason: 'invalid_email' };
	const normalizedPhone = normalizePhone(phone);
	if (!normalizedPhone) return { ok: false, reason: 'invalid_phone' };
	const normalizedDate = normalizeDate(updatedAt);
	if (!normalizedDate) return { ok: false, reason: 'invalid_date' };
	const normalizedRegion = Number.parseInt(region, 10);
	if (!Number.isInteger(normalizedRegion)) return { ok: false, reason: 'invalid_region' };
	return {
		ok: true,
		contact: {
			id,
			name: normalizeName(name),
			email: normalizedEmail,
			phone: normalizedPhone,
			updatedAt: normalizedDate,
			region: normalizedRegion,
		},
	};
}

/**
 * Deduplicates by normalized email, keeping the row with the latest `updatedAt`.
 * Ties break on id, then region, so the result never depends on the order in which
 * the regional importers happened to append their rows.
 */
export function dedupeContacts(contacts) {
	const best = new Map();
	for (const contact of contacts) {
		const current = best.get(contact.email);
		if (!current || outranks(contact, current)) best.set(contact.email, contact);
	}
	const unique = [...best.values()].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
	return { unique, duplicatesMerged: contacts.length - unique.length };
}

function outranks(candidate, incumbent) {
	if (candidate.updatedAt !== incumbent.updatedAt) return candidate.updatedAt > incumbent.updatedAt;
	if (candidate.id !== incumbent.id) return candidate.id > incumbent.id;
	return String(candidate.region) > String(incumbent.region);
}

/** Counts quarantine reasons into a plain object, always in `QUARANTINE_REASONS` order. */
export function tallyReasons(reasons) {
	const counts = {};
	for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
	const ordered = {};
	for (const reason of QUARANTINE_REASONS) if (counts[reason]) ordered[reason] = counts[reason];
	for (const reason of Object.keys(counts).sort()) if (!(reason in ordered)) ordered[reason] = counts[reason];
	return ordered;
}
