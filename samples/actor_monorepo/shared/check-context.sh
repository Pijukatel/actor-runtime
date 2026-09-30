#!/bin/sh
# Run by the shared Dockerfile: fails the build unless this script stayed executable and the Actor's folder
# is where ACTOR_PATH_IN_DOCKER_CONTEXT says, as in a build from a Git clone on the Apify platform.
set -e
test -f "$1/.actor/actor.json"
echo "Building $1 from the monorepo's Docker context"
