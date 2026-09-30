# Monorepo sample Actors

Two Actors in one npm-workspaces monorepo, laid out like
[`apify/actor-monorepo-example`](https://github.com/apify/actor-monorepo-example): each Actor's
`.actor/actor.json` sets `"dockerContextDir": "../../.."` and points at the Dockerfile and input schema
in `shared/`, and both import the shared package in `packages/greeting`.

```sh
cd actors/greeter
apify push
apify call --input '{"count": 3}'
```

`apify push` pushes the whole monorepo as the Docker context, and the build gets
`ACTOR_PATH_IN_DOCKER_CONTEXT` (here `actors/greeter`), as on the Apify platform when it builds from Git.

The Actors use only the `apify` package preinstalled in the `apify/actor-node` base image, so the build
installs nothing from the npm registry.
