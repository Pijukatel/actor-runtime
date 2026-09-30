/**
 * Renders the progress of a BuildKit build as BuildKit's own `--progress=plain` text, the format the Apify
 * platform's builds (`buildctl build --progress plain`) write to the build log. Over the Docker Engine API,
 * BuildKit reports progress as `{"id": "moby.buildkit.trace", "aux": "<base64>"}` events, each a
 * protobuf-encoded `moby.buildkit.v1.StatusResponse`; dockerode's own decoder prints `RUN` output still
 * base64-encoded, so the decoding is done here.
 */
import protobuf from 'protobufjs';

/** The `id` of a Docker Engine API build event whose `aux` carries a BuildKit status update. */
export const BUILDKIT_TRACE_ID = 'moby.buildkit.trace';

const timestamp = { fields: { seconds: { type: 'int64', id: 1 }, nanos: { type: 'int32', id: 2 } } };

/** `StatusResponse` from BuildKit's `api/services/control/control.proto`, trimmed to what is printed. */
const StatusResponse = protobuf.Root.fromJSON({
	nested: {
		Timestamp: timestamp,
		StatusResponse: {
			fields: {
				vertexes: { rule: 'repeated', type: 'Vertex', id: 1 },
				statuses: { rule: 'repeated', type: 'VertexStatus', id: 2 },
				logs: { rule: 'repeated', type: 'VertexLog', id: 3 },
				warnings: { rule: 'repeated', type: 'VertexWarning', id: 4 },
			},
		},
		Vertex: {
			fields: {
				digest: { type: 'string', id: 1 },
				name: { type: 'string', id: 3 },
				cached: { type: 'bool', id: 4 },
				started: { type: 'Timestamp', id: 5 },
				completed: { type: 'Timestamp', id: 6 },
				error: { type: 'string', id: 7 },
			},
		},
		VertexStatus: {
			fields: {
				ID: { type: 'string', id: 1 },
				vertex: { type: 'string', id: 2 },
				current: { type: 'int64', id: 4 },
				total: { type: 'int64', id: 5 },
				started: { type: 'Timestamp', id: 7 },
				completed: { type: 'Timestamp', id: 8 },
			},
		},
		VertexLog: {
			fields: {
				vertex: { type: 'string', id: 1 },
				timestamp: { type: 'Timestamp', id: 2 },
				msg: { type: 'bytes', id: 4 },
			},
		},
		VertexWarning: {
			fields: {
				vertex: { type: 'string', id: 1 },
				short: { type: 'bytes', id: 3 },
			},
		},
	},
}).lookupType('StatusResponse');

type Timestamp = { seconds?: number; nanos?: number };
type Status = {
	vertexes?: Array<{
		digest?: string;
		name?: string;
		cached?: boolean;
		started?: Timestamp;
		completed?: Timestamp;
		error?: string;
	}>;
	statuses?: Array<{
		ID?: string;
		vertex?: string;
		current?: number;
		total?: number;
		started?: Timestamp;
		completed?: Timestamp;
	}>;
	logs?: Array<{ vertex?: string; timestamp?: Timestamp; msg?: Buffer }>;
	warnings?: Array<{ vertex?: string; short?: Buffer }>;
};

type VertexState = {
	/** The `#N` BuildKit prints: steps are numbered in the order they first print something. */
	index?: number;
	started?: number;
	announced: boolean;
	finished: boolean;
	/** Log output after its last newline, printed once the rest of the line arrives. */
	partialLine: string;
	lastLogTime?: number;
};

function secondsOf(value: Timestamp | undefined): number | undefined {
	return value?.seconds ? value.seconds + (value.nanos ?? 0) / 1e9 : undefined;
}

/** Sizes as BuildKit prints them (decimal units, as Docker's `units.HumanSize`). */
function humanSize(bytes: number): string {
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return unit === 0 ? `${value}B` : `${value.toFixed(2)}${units[unit]}`;
}

/** One per build: vertex numbering and partial log lines carry over from one status update to the next. */
export class BuildKitProgressPrinter {
	private readonly vertices = new Map<string, VertexState>();
	private printed = 0;
	private readonly finishedStatuses = new Set<string>();

	/** The log text for one `aux` payload - empty when the update changes nothing that is printed. */
	write(aux: string): string {
		const status = StatusResponse.toObject(StatusResponse.decode(Buffer.from(aux, 'base64')), {
			longs: Number,
		}) as Status;
		const out: string[] = [];

		for (const vertex of status.vertexes ?? []) {
			if (!vertex.digest) continue;
			const state = this.stateOf(vertex.digest);
			state.started ??= secondsOf(vertex.started);
			if (!state.announced && (vertex.started || vertex.completed) && vertex.name) {
				out.push(`#${this.indexOf(state)} ${vertex.name}\n`);
				state.announced = true;
			}
			if (state.finished || !vertex.completed) continue;
			state.finished = true;
			if (state.partialLine) out.push(this.logLine(state, state.partialLine));
			state.partialLine = '';
			if (vertex.error) out.push(`#${this.indexOf(state)} ERROR: ${vertex.error}\n`);
			else if (vertex.cached) out.push(`#${this.indexOf(state)} CACHED\n`);
			else {
				const duration = (secondsOf(vertex.completed) ?? 0) - (state.started ?? 0);
				out.push(`#${this.indexOf(state)} DONE ${Math.max(duration, 0).toFixed(1)}s\n`);
			}
			out.push('\n');
		}

		for (const item of status.statuses ?? []) {
			if (!item.vertex || !item.ID || !item.completed || this.finishedStatuses.has(`${item.vertex} ${item.ID}`)) {
				continue;
			}
			this.finishedStatuses.add(`${item.vertex} ${item.ID}`);
			const state = this.stateOf(item.vertex);
			const size = item.total ? ` ${humanSize(item.current ?? 0)} / ${humanSize(item.total)}` : '';
			const duration = (secondsOf(item.completed) ?? 0) - (secondsOf(item.started) ?? 0);
			out.push(`#${this.indexOf(state)} ${item.ID}${size} ${Math.max(duration, 0).toFixed(1)}s done\n`);
		}

		for (const log of status.logs ?? []) {
			if (!log.vertex || !log.msg) continue;
			const state = this.stateOf(log.vertex);
			state.lastLogTime = secondsOf(log.timestamp);
			const lines = (state.partialLine + log.msg.toString('utf8')).split('\n');
			state.partialLine = lines.pop() ?? '';
			for (const line of lines) out.push(this.logLine(state, line));
		}

		for (const warning of status.warnings ?? []) {
			if (!warning.short) continue;
			const prefix = warning.vertex ? `#${this.indexOf(this.stateOf(warning.vertex))} ` : '';
			out.push(`${prefix}WARN: ${warning.short.toString('utf8')}\n`);
		}

		return out.join('');
	}

	private stateOf(digest: string): VertexState {
		let state = this.vertices.get(digest);
		if (!state) {
			state = { announced: false, finished: false, partialLine: '' };
			this.vertices.set(digest, state);
		}
		return state;
	}

	private indexOf(state: VertexState): number {
		state.index ??= ++this.printed;
		return state.index;
	}

	/** `#N <seconds since the step started> <line>`, as BuildKit prints a step's own output. */
	private logLine(state: VertexState, line: string): string {
		const elapsed =
			state.started !== undefined && state.lastLogTime !== undefined ? state.lastLogTime - state.started : 0;
		return `#${this.indexOf(state)} ${Math.max(elapsed, 0).toFixed(3)} ${line}\n`;
	}
}
