# Environment variables sample Actor

A sample Actor that only logs, showing the three kinds of environment variables in `.actor/actor.json`:

- `BUILD_GREETING` - read by the Dockerfile during the build. The build fails without it.
- `RUN_GREETING` - a plain variable read by the run.
- `API_KEY` - a secret read by the run. It is never logged, only whether it is set.

```sh
apify secrets add envVarsSampleApiKey 'my-secret-key'
apify push    # the build fails: BUILD_GREETING is not set yet
apify api PUT v2/actors/<actorId>/versions/0.0 --body '{"applyEnvVarsToBuild": true}'
apify push --force    # nothing changed locally, so the CLI needs --force; the build logs
                      # "Build: BUILD_GREETING=hello-from-the-build"
apify call    # the run logs RUN_GREETING and "API_KEY is set (13 characters)"
```
