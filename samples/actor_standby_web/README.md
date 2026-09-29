# Standby web sample Actor

A small Actor for trying Actor Standby callers against the local runtime. `.actor/actor.json` sets
`usesStandbyMode`, so `apify push` enables Standby.

- **Standby run**: serves a web page whose script calls `GET /api/greeting` with a root-relative URL, as most
  web UIs do. That works because the Actor owns `/` of its standby URL, as on `*.apify.actor`.
- **Ordinary run** (`apify call`): a client of a standby Actor, this one unless the `standbyActor` input
  names another. It reads that Actor's `standbyUrl` through the API - from inside a container that is
  `http://apify-api:3333/actor-runtime/standby/<username>--<actor-name>` - calls `/api/greeting` there and
  pushes the answer to its default dataset.

```bash
apify push
TOKEN=<your token>

# In a browser:
#   http://<username>--my-standby-web-actor.localhost:3333/?token=<your token>
curl "http://<username>--my-standby-web-actor.localhost:3333/api/greeting?name=Ada&token=$TOKEN"
# The same endpoint, for clients that do not resolve *.localhost:
curl "http://localhost:3333/actor-runtime/standby/<username>--my-standby-web-actor/api/greeting?name=Ada&token=$TOKEN"

apify call --input '{"name":"Actor"}'   # another run calls the standby endpoint from its container
```
