import { createRequire } from 'node:module';

import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';

import { BuildKitProgressPrinter } from '../../src/driver/buildkit-progress.js';

// Encoded with the full `StatusResponse` schema dockerode ships, not the trimmed one under test.
const StatusResponse = protobuf
	.loadSync(createRequire(import.meta.url).resolve('dockerode/lib/proto/buildkit_status.proto'))
	.lookupType('moby.buildkit.v1.StatusResponse');

const at = (seconds: number) => ({ seconds: 1_700_000_000 + Math.floor(seconds), nanos: (seconds % 1) * 1e9 });

function aux(status: object): string {
	return Buffer.from(StatusResponse.encode(StatusResponse.fromObject(status)).finish()).toString('base64');
}

describe('BuildKitProgressPrinter', () => {
	it("prints a build as `--progress=plain` does: numbered steps, each step's output with its time, and how it ended", () => {
		const printer = new BuildKitProgressPrinter();
		const out = [
			// Both steps are reported up front; the queued one is numbered only once it prints.
			aux({
				vertexes: [
					{ digest: 'sha256:run', name: '[2/2] RUN echo hi' },
					{ digest: 'sha256:from', name: '[1/2] FROM base', started: at(0) },
				],
			}),
			aux({
				vertexes: [
					{
						digest: 'sha256:from',
						name: '[1/2] FROM base',
						started: at(0),
						completed: at(0.5),
						cached: true,
					},
				],
			}),
			aux({ vertexes: [{ digest: 'sha256:run', name: '[2/2] RUN echo hi', started: at(1) }] }),
			aux({ logs: [{ vertex: 'sha256:run', timestamp: at(1.25), msg: Buffer.from('hi\npart') }] }),
			aux({ logs: [{ vertex: 'sha256:run', timestamp: at(1.5), msg: Buffer.from('ial\nlast') }] }),
			aux({
				vertexes: [{ digest: 'sha256:run', name: '[2/2] RUN echo hi', started: at(1), completed: at(2.2) }],
			}),
		]
			.map((payload) => printer.write(payload))
			.join('');

		expect(out).toBe(
			'#1 [1/2] FROM base\n#1 CACHED\n\n' +
				'#2 [2/2] RUN echo hi\n#2 0.250 hi\n#2 0.500 partial\n#2 0.500 last\n#2 DONE 1.2s\n\n',
		);
	});

	it("prints a failed step's error and a finished transfer's size, and nothing for an update that changes neither", () => {
		const printer = new BuildKitProgressPrinter();
		expect(
			printer.write(aux({ vertexes: [{ digest: 'sha256:a', name: '[1/1] RUN false', started: at(0) }] })),
		).toBe('#1 [1/1] RUN false\n');
		const pulling = { vertex: 'sha256:a', ID: 'sha256:layer', current: 500, total: 3_400_000, started: at(0) };
		expect(printer.write(aux({ statuses: [pulling] }))).toBe('');
		const pulled = { ...pulling, current: 3_400_000, completed: at(0.3) };
		expect(printer.write(aux({ statuses: [pulled] }))).toBe('#1 sha256:layer 3.40MB / 3.40MB 0.3s done\n');
		expect(printer.write(aux({ statuses: [pulled] }))).toBe('');
		expect(
			printer.write(
				aux({ vertexes: [{ digest: 'sha256:a', started: at(0), completed: at(1), error: 'exit code: 1' }] }),
			),
		).toBe('#1 ERROR: exit code: 1\n\n');
	});

	it('prints warnings against the step they belong to', () => {
		const printer = new BuildKitProgressPrinter();
		printer.write(
			aux({ vertexes: [{ digest: 'sha256:a', name: '[internal] load build definition', started: at(0) }] }),
		);
		expect(
			printer.write(aux({ warnings: [{ vertex: 'sha256:a', short: Buffer.from('FromAsCasing: mismatch') }] })),
		).toBe('#1 WARN: FromAsCasing: mismatch\n');
	});
});
