# Ships with the Apify SDK preinstalled, so the build needs no `npm install`.
FROM apify/actor-node:24

# The version's environment variables reach the build as build arguments only with "Apply environment
# variables also to the build process" (`applyEnvVarsToBuild`) turned on in Code > Environment variables.
ARG BUILD_GREETING
RUN test -n "$BUILD_GREETING" || { echo 'BUILD_GREETING is not set: turn on "Apply environment variables also to the build process" in Code > Environment variables (applyEnvVarsToBuild)'; exit 1; }
RUN echo "Build: BUILD_GREETING=$BUILD_GREETING"

COPY src ./src
CMD ["node", "src/main.mjs"]
