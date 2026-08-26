/** Basename for the resolver's Dockerfile candidates and the bundled default's own tar-entry name. */
export const DEFAULT_DOCKERFILE_NAME = 'Dockerfile';

/** Injected when an Actor's pushed source names no Dockerfile. Matches the Apify platform's default Dockerfile. */
export const DEFAULT_DOCKERFILE_CONTENT = `# This is a default Dockerfile is used for Actors that don't have a Dockerfile.
FROM apify/actor-node:20

# Copy all files and directories from the directory to the Docker image
COPY . ./

# Install NPM packages, skip optional and development dependencies to keep the image small,
# avoid logging to much and show log the dependency tree
RUN npm install --quiet --only=prod --no-optional \\
 && (npm list || true)
`;
