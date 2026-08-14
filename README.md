# actor-runtime

A minimal, self-contained "local Apify platform" in a single Docker image. Start
it with one `docker run`, point the stock `apify-cli` at it, and run the full
Actor dev loop offline: `apify push` -> build -> run -> inspect runs, builds and
the run's default storages (key-value store, dataset, request queue).
