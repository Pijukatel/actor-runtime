import process from 'node:process';

import { Actor } from 'apify';

import { greeting } from '../../../packages/greeting/index.js';

await Actor.init();
const { count = 2 } = (await Actor.getInput()) ?? {};
for (let index = 1; index <= count; index++) {
	await Actor.pushData({
		index,
		text: greeting('shouter', index).toUpperCase(),
		actorPath: process.env.ACTOR_PATH_IN_DOCKER_CONTEXT,
	});
}
await Actor.exit();
