/**
 * On-demand fixture Actor for the on-demand-calls-standby e2e test.
 *
 * Input is the standby Actor's NAME only (`standbyActorName`), never a
 * username-qualified id -- an id like `username~standby-actor` is only ever
 * meaningful on whatever single environment minted it, so this Actor
 * resolves its own owning user's id live and builds `{username}~{name}`
 * itself, the same on the real platform and locally.
 */
import { Actor } from 'apify';

await Actor.main(async () => {
    const actorInput = (await Actor.getInput()) ?? {};
    const standbyActorName = actorInput.standbyActorName;
    if (!standbyActorName) {
        throw new Error(
            'Missing required input field "standbyActorName" (the name of the standby ' +
            'Actor to call, e.g. {"standbyActorName": "standby-actor"}).',
        );
    }
    const greeting = actorInput.greeting ?? 'hi';

    const client = Actor.newClient();

    // Username resolved live, never hardcoded or taken as input (see module
    // docstring).
    console.log('Resolving the acting user via the configured client (client.user(userId).get())');
    const me = await client.user(Actor.getEnv().userId).get();
    const username = me?.username;
    if (!username) {
        throw new Error("Could not resolve the acting user's username from client.user(userId).get().");
    }
    // {username}~{name} is the platform's own Actor-id convention.
    const standbyActorId = `${username}~${standbyActorName}`;

    console.log(`Discovering standby Actor '${standbyActorId}' via the configured client`);
    const actor = await client.actor(standbyActorId).get();
    const standbyUrl = actor.standbyUrl;
    console.log(`Calling standby Actor at ${standbyUrl}`);

    // No SDK method calls another Actor's HTTP endpoint, so fetch handles
    // this one call directly (still authenticated, via this run's own token).
    const callUrl = `${standbyUrl}/echo?greeting=${encodeURIComponent(greeting)}`;
    const response = await fetch(callUrl, {
        headers: { authorization: `Bearer ${Actor.getEnv().token}` },
        signal: AbortSignal.timeout(30_000),
    });
    // A non-2xx reply must fail this run, not be persisted as the standby's
    // answer.
    if (!response.ok) {
        throw new Error(`Standby call failed with status ${response.status}`);
    }
    const received = await response.json();
    console.log(`Received from standby Actor: ${JSON.stringify(received)}`);

    // Persist the standby Actor's response twice: into this run's own
    // dataset (through the SDK, like an SDK Actor at home would) and as the
    // OUTPUT key-value record.
    await Actor.pushData([received]);
    await Actor.setValue('OUTPUT', { receivedFromStandby: received });
    console.log('On-demand Actor finished calling the standby Actor.');
});
