import { DockerDriver } from './docker-driver.js';
import type { Driver } from './types.js';

export type { BuildContext, BuildOutcome, Driver, RunContext, RunOutcome } from './types.js';

export async function createDriver(): Promise<Driver> {
	const driver = new DockerDriver();
	await driver.init();
	return driver;
}
