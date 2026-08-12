/**
 * Sample Actor exercising the full Apify SDK storage surface: INPUT read,
 * OUTPUT write, dataset push and request-queue enqueue.
 *
 * `tone`/`repeatCount`/`shout`/`recipients` (see `.actor/input_schema.json`)
 * showcase the Input tab's widget types; each defaults to a no-op, so a run
 * that omits them (e.g. the e2e suite's plain `{"greeting": "howdy"}`) keeps
 * producing the same output as before the input schema existed.
 */
import { Actor } from 'apify';

// `tone` (the input schema's enum/select showcase: friendly/formal/playful,
// default "friendly") selects the template that wraps the styled greeting
// before repeatCount/join. "friendly" is a pure no-op template, so any run
// that never sets `tone` keeps producing byte-identical `processedGreeting`
// output to before this template existed.
const TONE_TEMPLATES = {
    friendly: (greeting) => `${greeting}`,
    formal: (greeting) => `Dear recipient, ${greeting}. Regards.`,
    playful: (greeting) => `${greeting}!! :)`,
};

/**
 * Apply `tone`'s template to `text`. Anything that isn't one of the schema's
 * three declared enum values -- an unrecognized string, a non-string (input
 * is never validated against the schema, so a client can send anything), or
 * an absent key -- fails soft to the same "friendly" no-op template `tone`'s
 * own schema default already uses, rather than crashing or silently
 * producing undefined.
 */
function styledGreeting(text, tone) {
    const template = typeof tone === 'string' ? TONE_TEMPLATES[tone] : null;
    return (template ?? TONE_TEMPLATES.friendly)(text);
}

await Actor.main(async () => {
    const actorInput = (await Actor.getInput()) ?? {};
    const greeting = actorInput.greeting ?? 'hello';

    // `repeatCount`/`shout` both default to the schema's own no-op values (1
    // repeat, no shouting), so an unedited/default run's processedGreeting
    // always equals the plain greeting.
    let repeatCount = Number.parseInt(actorInput.repeatCount, 10);
    if (Number.isNaN(repeatCount)) repeatCount = 1;
    repeatCount = Math.max(repeatCount, 0);
    const shout = Boolean(actorInput.shout ?? false);
    // `greeting` itself is left exactly as read (any JSON type, permissive
    // input) -- only the derived text below is coerced to a string, so a
    // non-string greeting can never crash the Actor.
    const greetingText = typeof greeting === 'string' ? greeting : String(greeting);
    const base = shout ? greetingText.toUpperCase() : greetingText;

    const tone = actorInput.tone ?? 'friendly';
    const styled = styledGreeting(base, tone);
    const processedGreeting = Array(repeatCount).fill(styled).join(' ');

    // `recipients` (a list of names, stringList editor, no schema `default`
    // -- only a console-only `prefill`): produces one styled greeting per
    // recipient. A missing/non-list value fails soft to an empty list.
    const rawRecipients = actorInput.recipients ?? [];
    const recipients = Array.isArray(rawRecipients)
        ? rawRecipients.map((name) => (typeof name === 'string' ? name : String(name)))
        : [];
    const recipientGreetings = recipients.map((name) => `${styled}, ${name}!`);

    console.log(`Sample Actor started. Input greeting = ${JSON.stringify(greeting)}`);

    // 1) Key-value store: write an OUTPUT record that echoes the input and
    //    shows repeatCount/shout/tone/recipients actually affecting the
    //    greeting.
    await Actor.setValue('OUTPUT', {
        greeting,
        processedGreeting,
        recipientGreetings,
        receivedInput: actorInput,
        status: 'ok',
    });

    // 2) Dataset: push one item derived from the input, plus one more per
    //    recipient (empty `recipients` -> no extra items).
    await Actor.pushData({ message: `${greeting} world`, index: 1 });
    for (const [i, name] of recipients.entries()) {
        await Actor.pushData({ message: recipientGreetings[i], recipient: name, index: i + 2 });
    }

    // 3) Request queue: enqueue one request.
    const requestQueue = await Actor.openRequestQueue();
    await requestQueue.addRequest({ url: 'https://example.com/from-actor' });

    console.log(
        `Sample Actor finished: wrote OUTPUT, ${1 + recipients.length} dataset item(s), 1 queued request.`,
    );
});
