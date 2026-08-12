/**
 * Fixture Actor exercising the full apify SDK path: `Actor.main`,
 * `Actor.isAtHome()`, a real API round trip via
 * `Actor.newClient().user('me').get()` (the "me" alias round trip), and
 * `Actor.pushData()` for the storage write.
 */
import { Actor } from 'apify';

await Actor.main(async () => {
    // (a) isAtHome, through the SDK's own accessor.
    const isAtHome = Actor.isAtHome();
    const datasetId = Actor.getEnv().defaultDatasetId;

    // (b) a real network round trip back into the runtime's own API, using
    // the SDK-configured client (token/API URL come from the Actor's
    // configuration, same as everywhere else in the SDK).
    const client = Actor.newClient();
    const me = await client.user('me').get();
    const username = me?.username ?? null;

    const result = { is_at_home: Boolean(isAtHome), user: username, dataset_id: datasetId };
    console.log(`isathome Actor resolved: ${JSON.stringify(result)}`);

    // (c) write the result into the run's real default dataset through the
    // SDK -- an API-based storage write, not a local-disk write.
    await Actor.pushData(result);

    console.log('isathome Actor finished: pushed result via Actor.pushData().');
});
