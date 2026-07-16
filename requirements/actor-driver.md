# Actor build
- The system is capable of building Actor docker image
- A build is produced by building a docker image from the Actor source that was
  pushed to the system
- `Actor build` is an object that:
  - Is saved under specific `User`/`Actor`/`Builds`
  - Has a status that reaches a terminal state: succeeded or failed
  - Can be inspected from frontend console

# Actor run
- The system is capable of running containerized Actor
- A run launches the Actor's built image as a container, with the Actor's input
  and its default storages (key-value store, dataset, request queue) wired in
- The Actor container runs as the user defined by its image, which for official
  Apify base images is a non-root user. The system must provision each run's
  storage so that this (possibly non-root) user can write to it, independent of
  the user the runtime itself runs as
- `Actor run` is an object that:
  - Is saved under specific `User`/`Actor`/`Runs`
  - Has a status that reaches a terminal state: succeeded, failed, aborted or
    timed-out
  - Exposes a log; every line carries a UTC timestamp prefix (container
    output is captured with Docker's per-line RFC3339 timestamps, mirroring
    real-platform run logs; the runtime's own log lines -- RUN ERROR, standby
    teardown notes, ... -- are stamped the same way at write time)
  - Can be inspected from frontend console

# Networking
- Every Actor container joins a shared, user-defined Docker network (not the
  default bridge), so Actor containers can reach each other, and the runtime
  itself, by name
- The runtime self-attaches to that same network under a stable alias at boot,
  so `APIFY_API_BASE_URL` inside any Actor container resolves back to the
  runtime's own API. When the runtime is not itself running as a container
  (e.g. run directly on a host), self-attach is skipped with a warning rather
  than failing boot; Actor containers still join the network
- If the shared network itself cannot be created or found at boot (e.g. a
  daemon that restricts user-defined network creation), on-demand runs fall
  back to Docker's default bridge network so they keep working exactly as
  before standby actors existed; a standby Actor's non-blocking start fails
  immediately with a clear, actionable error instead, since it has no
  degraded-but-working mode (its container is only reachable by network DNS
  name)

# Standby actor
- An Actor may opt into standby mode (`usesStandbyMode: true` in
  `.actor/actor.json`, or an explicit API field): instead of running once and
  exiting, the system keeps at most one warm, long-lived container per such
  Actor, started lazily on the first forwarded HTTP request
- Before forwarding, the system waits for the container to answer the
  readiness probe on its fixed `ACTOR_STANDBY_PORT`; a container that never
  becomes ready fails the request observably rather than hanging
- After a configurable idle timeout with no forwarded requests, the system
  stops and removes the container on its own (no further request required) and
  the underlying run reaches a terminal status
- A standby run's options (build, memory, no wall-clock timeout) are forced
  from the Actor's standby config, not any caller-supplied value
- See `api.md`'s "Standby actors" section for the forwarding route and
  authorization rules
