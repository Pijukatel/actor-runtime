# Shared by every Actor in this monorepo. The builder passes the Actor's folder, relative to the
# Docker context (the monorepo root), as ACTOR_PATH_IN_DOCKER_CONTEXT.
FROM apify/actor-node:24
ARG ACTOR_PATH_IN_DOCKER_CONTEXT

# The base image's preinstalled `apify` package is all the Actors need, so there is no npm install.
COPY --chown=myuser:myuser packages ./packages
COPY --chown=myuser:myuser "${ACTOR_PATH_IN_DOCKER_CONTEXT}" "./${ACTOR_PATH_IN_DOCKER_CONTEXT}"

ENV ACTOR_PATH_IN_DOCKER_CONTEXT="${ACTOR_PATH_IN_DOCKER_CONTEXT}"
CMD node "${ACTOR_PATH_IN_DOCKER_CONTEXT}/src/main.js"
