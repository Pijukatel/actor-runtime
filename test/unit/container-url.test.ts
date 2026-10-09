import { describe, expect, it } from 'vitest';

import { CONTAINER_PATH_PREFIX, containerUrl, runLabelFromHost } from '../../src/services/container-url.js';

describe('containerUrl', () => {
	it('builds the host-facing URL in the platform shape, lowercased as a hostname is, and the container one on the API alias', () => {
		expect(containerUrl('HG7ML7M8z78YcAPEB')).toBe('http://hg7ml7m8z78ycapeb.runs.localhost:3333');
		expect(containerUrl('HG7ML7M8z78YcAPEB', 'container')).toBe(
			`http://apify-api:3333${CONTAINER_PATH_PREFIX}/HG7ML7M8z78YcAPEB`,
		);
	});

	it('reads the run label back from a Host header of that shape only', () => {
		expect(runLabelFromHost('hg7ml7m8z78ycapeb.runs.localhost:3333')).toBe('hg7ml7m8z78ycapeb');
		expect(runLabelFromHost('HG7ML7M8z78YcAPEB.runs.localhost')).toBe('hg7ml7m8z78ycapeb');
		// A standby Actor's host, the console, the API itself: none of them.
		expect(runLabelFromHost('john--my-actor.localhost:3333')).toBeUndefined();
		expect(runLabelFromHost('localhost:3333')).toBeUndefined();
		expect(runLabelFromHost('runs.localhost:3333')).toBeUndefined();
		expect(runLabelFromHost(undefined)).toBeUndefined();
	});
});
