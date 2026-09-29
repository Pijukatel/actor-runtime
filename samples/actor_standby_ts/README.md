# TypeScript Standby sample Actor

An Actor server for trying Actor Standby against the local runtime; `samples/actor_standby_py` is the same
server in Python. `.actor/actor.json` sets `usesStandbyMode`, so `apify push` enables Standby.

```bash
apify push
URL=http://localhost:3333/actor-runtime/standby/<username>--my-standby-actor-ts
TOKEN=<your token>

curl "$URL/?token=$TOKEN"                                   # what the server offers
curl "$URL/hello?name=Ada&token=$TOKEN"                     # a greeting; one dataset item per call
curl -X POST -H 'content-type: application/json' -d '{"a":1}' "$URL/echo?token=$TOKEN"
curl "$URL/stats?token=$TOKEN"                              # this run's and every run's request count
curl -N "$URL/stream?count=5&token=$TOKEN"                  # Server-Sent Events, one every 0.5 s
npx wscat -c "${URL/http/ws}/ws?token=$TOKEN"               # a websocket echo
```

- The first request starts a standby run and waits until the server answers the readiness probe; later
  requests reuse that run. Each `/hello` pushes one item to the run's default dataset.
- `/stats` keeps a running total across runs in the named key-value store `standby-sample-ts-stats`, saved on
  every `persistState` event and when the run is wound down.
- After `idleTimeoutSecs` without a request (300 by default; shorten it with
  `apify api PUT v2/actors/<actorId> --body '{"actorStandby":{"idleTimeoutSecs":10}}'`) the run gets the
  `aborting` event, stops serving and ends `SUCCEEDED`. The next request starts a fresh run.
- `apify call` starts an ordinary run instead, which says where to send requests and exits.
