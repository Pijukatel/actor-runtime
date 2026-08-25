/**
 * The bundled default Dockerfile, injected by `dockerfile-location.ts`'s resolver when an Actor's
 * pushed source names no Dockerfile at all (no `dockerfile` field in `.actor/actor.json`, and no
 * case-insensitive `Dockerfile` at `.actor/Dockerfile` or the Actor root). This is apify-worker's own
 * platform-parity fallback, copied here verbatim (byte-for-byte, including its own leading comment) from
 * `apify-worker/src/actor/build/default_Dockerfile` - not reinterpreted or "improved" - so a locally
 * built default-Dockerfile image matches what the real platform would have produced for the same,
 * Dockerfile-less source.
 *
 * A string constant, not a sibling file copied at build/run time: the runtime's build input is already
 * an in-memory `SourceFile[]`/tar, not a working directory on disk, and the codebase has no existing
 * pattern for shipping a non-TS asset file (see `2-design.md`'s Alternatives).
 */
export const DEFAULT_DOCKERFILE_NAME = 'Dockerfile';

export const DEFAULT_DOCKERFILE_CONTENT = `# This is a default Dockerfile is used for Actors that don't have a Dockerfile.
FROM apify/actor-node:20

# Copy all files and directories from the directory to the Docker image
COPY . ./

# Install NPM packages, skip optional and development dependencies to keep the image small,
# avoid logging to much and show log the dependency tree
RUN npm install --quiet --only=prod --no-optional \\
 && (npm list || true)
`;
