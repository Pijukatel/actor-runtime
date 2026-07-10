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
- `Actor run` is an object that:
  - Is saved under specific `User`/`Actor`/`Runs`
  - Has a status that reaches a terminal state: succeeded, failed, aborted or
    timed-out
  - Exposes a log
  - Can be inspected from frontend console
