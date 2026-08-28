/**
 * Deterministic generator for the eight regional CRM exports.
 *
 * Everything below is driven by a single PRNG stream seeded from the Actor input, so the same
 * seed always produces byte-identical exports - which is what lets the simulator publish a
 * ground-truth report the rest of the pipeline can be measured against.
 */

import { csvEscape, HEADER } from './crm.js';

export const REGIONS = [1, 2, 3, 4, 5, 6, 7, 8];
export const ROWS_PER_REGION = 5000;

/** Region 7 is the poisoned export: its malformed rate is above the importers' 5% circuit breaker. */
export function malformedRateForRegion(region) {
	return region === 7 ? 0.07 : 0.02 + (region - 1) * 0.002;
}

const DUPLICATE_RATE = 0.114; // ~10% of all 40 000 rows, since region 1 has nothing to duplicate yet
const MISSING_ID_RATE = 0.001;
const INVALID_EMAIL_RATE = 0.004;
const INVALID_PHONE_RATE = 0.003;
const INVALID_DATE_RATE = 0.003;

const FIRST_NAMES = [
	'Jan',
	'Petr',
	'Eva',
	'Marie',
	'Tomas',
	'Lucie',
	'Martin',
	'Jana',
	'Pavel',
	'Katerina',
	'Ondrej',
	'Tereza',
	'Filip',
	'Barbora',
	'David',
	'Nikola',
	'Adam',
	'Veronika',
	'Jakub',
	'Klara',
];
const LAST_NAMES = [
	'Novak',
	'Svoboda',
	'Novotny',
	'Dvorak',
	'Cerny',
	'Prochazka',
	'Kucera',
	'Vesely',
	'Horak',
	'Nemec',
	'Marek',
	'Pospisil',
	'Pokorny',
	'Hajek',
	'Kral',
	'Jelinek',
	'Ruzicka',
	'Benes',
	'Fiala',
	'Sedlacek',
];
const DOMAINS = ['example.com', 'example.cz', 'mail.example.org', 'corp.example.net'];

/** mulberry32 - small, fast, and stable across Node versions. */
export function makeRng(seed) {
	let state = seed >>> 0;
	return function next() {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const pad = (value, width) => String(value).padStart(width, '0');

const EPOCH_START = Date.UTC(2023, 0, 1);
const EPOCH_END = Date.UTC(2025, 0, 1);

function freshContact(rng, region, serial) {
	const first = pick(rng, FIRST_NAMES);
	const last = pick(rng, LAST_NAMES);
	const national = `${pick(rng, ['601', '602', '731', '777', '608'])}${pad(Math.floor(rng() * 1e6), 6)}`;
	return {
		id: `C${pad(serial, 7)}`,
		first,
		last,
		email: `${first}.${last}${serial}@${pick(rng, DOMAINS)}`.toLowerCase(),
		// The canonical phone every formatting variant below has to normalize back to.
		phone: rng() < 0.9 ? `+420${national}` : `+1202${pad(Math.floor(rng() * 1e7), 7)}`,
		updatedAt: EPOCH_START + Math.floor(rng() * (EPOCH_END - EPOCH_START)),
		region,
	};
}

/** The same person, seen by another region's CRM: new local id, new touch date, other formatting. */
function duplicateOf(base, rng, region, serial) {
	const shiftDays = Math.floor(rng() * 120) - 60;
	return {
		...base,
		id: `C${pad(serial, 7)}`,
		region,
		updatedAt: base.updatedAt + shiftDays * 86400000,
		isDuplicate: true,
	};
}

// --- formatting variants: valid data, just not normalized ------------------------------------

function formatName(contact, rng) {
	const roll = rng();
	if (roll < 0.15) return `${contact.last.toUpperCase()}, ${contact.first}`;
	if (roll < 0.3) return `  ${contact.first}   ${contact.last} `;
	if (roll < 0.4) return `${contact.first} ${contact.last}`.toUpperCase();
	return `${contact.first} ${contact.last}`;
}

function formatEmail(contact, rng) {
	const roll = rng();
	if (roll < 0.2) return contact.email.toUpperCase();
	if (roll < 0.4) return ` ${contact.email} `;
	if (roll < 0.5) return `<${contact.email}>`;
	if (roll < 0.6) return contact.email.replace(/^(.)/, (c) => c.toUpperCase());
	return contact.email;
}

function formatPhone(contact, rng) {
	const digits = contact.phone.slice(1);
	const roll = rng();
	if (contact.phone.startsWith('+420')) {
		const national = digits.slice(3);
		if (roll < 0.2) return national;
		if (roll < 0.35) return `00420${national}`;
		if (roll < 0.5) return `+420 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
		if (roll < 0.6) return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
		if (roll < 0.7) return `420${national}`;
		return contact.phone;
	}
	if (roll < 0.3) return `00${digits}`;
	if (roll < 0.5) return `+${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4)}`;
	return contact.phone;
}

function formatDate(contact, rng) {
	const date = new Date(contact.updatedAt);
	const yyyy = date.getUTCFullYear();
	const mm = pad(date.getUTCMonth() + 1, 2);
	const dd = pad(date.getUTCDate(), 2);
	const hh = pad(date.getUTCHours(), 2);
	const mi = pad(date.getUTCMinutes(), 2);
	const ss = pad(date.getUTCSeconds(), 2);
	const roll = rng();
	if (roll < 0.35) return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
	if (roll < 0.55) return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
	if (roll < 0.7) return `${dd}.${mm}.${yyyy}`;
	if (roll < 0.82) return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
	if (roll < 0.92) return String(Math.floor(contact.updatedAt / 1000));
	return `${yyyy}-${mm}-${dd}`;
}

// --- defect injection -------------------------------------------------------------------------

const BROKEN_EMAILS = ['not-an-email', 'jan.novak(at)example.cz', '@example.com', 'unknown'];
const BROKEN_PHONES = ['n/a', '+420', 'see notes', '00'];
const BROKEN_DATES = ['N/A', 'yesterday', '32.13.2024', 'unknown'];

function emitLine(fields) {
	return fields.map(csvEscape).join(',');
}

/**
 * Generates all eight exports. Returns a Map of region -> CSV text and per-region injection stats.
 */
export function generateExports(seed) {
	const rng = makeRng(seed);
	const files = new Map();
	const stats = [];
	const pool = []; // canonical contacts from *previous* regions - duplicates are cross-region only
	let serial = 0;

	for (const region of REGIONS) {
		const malformedRate = malformedRateForRegion(region);
		const lines = [HEADER];
		const fresh = [];
		const injected = {
			duplicates: 0,
			malformed: 0,
			missing_id: 0,
			invalid_email: 0,
			invalid_phone: 0,
			invalid_date: 0,
		};

		for (let i = 0; i < ROWS_PER_REGION; i++) {
			serial += 1;
			let contact;
			if (pool.length > 0 && rng() < DUPLICATE_RATE) {
				contact = duplicateOf(pool[Math.floor(rng() * pool.length)], rng, region, serial);
				injected.duplicates += 1;
			} else {
				contact = freshContact(rng, region, serial);
				fresh.push(contact);
			}

			const fields = [
				contact.id,
				formatName(contact, rng),
				formatEmail(contact, rng),
				formatPhone(contact, rng),
				formatDate(contact, rng),
				String(region),
			];

			const defect = rng();
			if (defect < malformedRate) {
				injected.malformed += 1;
				// Wrong column count, both directions: a dropped column and a stray extra one.
				if (rng() < 0.5) lines.push(emitLine([fields[0], fields[1], fields[2], fields[4], fields[5]]));
				else lines.push(emitLine([...fields.slice(0, 4), 'legacy_note', ...fields.slice(4)]));
				continue;
			}
			let offset = malformedRate;
			if (defect < (offset += MISSING_ID_RATE)) {
				injected.missing_id += 1;
				fields[0] = '';
			} else if (defect < (offset += INVALID_EMAIL_RATE)) {
				injected.invalid_email += 1;
				fields[2] = pick(rng, BROKEN_EMAILS);
			} else if (defect < (offset += INVALID_PHONE_RATE)) {
				injected.invalid_phone += 1;
				fields[3] = pick(rng, BROKEN_PHONES);
			} else if (defect < (offset += INVALID_DATE_RATE)) {
				injected.invalid_date += 1;
				fields[4] = pick(rng, BROKEN_DATES);
			}
			lines.push(emitLine(fields));
		}

		files.set(region, `${lines.join('\n')}\n`);
		stats.push({ region, rows: ROWS_PER_REGION, malformedRate, injected });
		pool.push(...fresh);
	}

	return { files, stats };
}
