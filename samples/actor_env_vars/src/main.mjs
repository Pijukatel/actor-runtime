import { Actor } from 'apify';

await Actor.init();

// Secret values are never logged, only whether they arrived.
const describeSecret = (value) => (value ? `is set (${value.length} characters)` : 'is not set');

// Decrypts secret input fields with the run's APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE/_PASSPHRASE.
const input = (await Actor.getInput()) ?? {};

console.log(`Run: RUN_GREETING=${process.env.RUN_GREETING}`);
console.log(`Run: API_KEY ${describeSecret(process.env.API_KEY)}`);
console.log(`Run: input message=${input.message}`);
console.log(`Run: input password ${describeSecret(input.password)}`);

await Actor.exit();
