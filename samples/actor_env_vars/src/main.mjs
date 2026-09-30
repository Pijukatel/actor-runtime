import { Actor } from 'apify';

await Actor.init();

// Decrypts secret input fields with the run's APIFY_INPUT_SECRETS_PRIVATE_KEY_FILE/_PASSPHRASE.
const input = (await Actor.getInput()) ?? {};

console.log(`Run: RUN_GREETING=${process.env.RUN_GREETING}`);
// The run log masks a secret env var's exact value as *********.
console.log(`Run: API_KEY=${process.env.API_KEY}`);
console.log(`Run: input message=${input.message}`);
// A secret input field is not masked: it is printed as it is.
console.log(`Run: input password=${input.password}`);

await Actor.exit();
