# Environment variables sample Actor

A sample Actor that only logs, showing the environment variables in `.actor/actor.json` and a secret
input field:

- `BUILD_GREETING` - read by the Dockerfile during the build. The build fails without it.
- `RUN_GREETING` - a plain variable read by the run.
- `API_KEY` - a secret read by the run. The run prints it, and the run log masks it as `*********`.
- `password` input field - a secret input (`isSecret` in `.actor/input_schema.json`), stored encrypted
  and decrypted by `Actor.getInput()` in the run. The run prints it too, and the log does **not** mask
  it: only secret env vars (and `APIFY_TOKEN`) are masked, as on the platform.

Environment variables reach the build only with the version's "Apply environment variables also to the
build process" setting (`applyEnvVarsToBuild`) on. It is off by default, and `apify push` cannot turn
it on, so the first push fails the build:

```sh
apify secrets add envVarsSampleApiKey 'my-secret-key'
apify push    # the build fails: BUILD_GREETING is not set
apify api PUT v2/actors/<actorId>/versions/0.0 --body '{"applyEnvVarsToBuild": true}'
apify push --force    # nothing changed locally, so the CLI needs --force; the build logs
                      # "Build: BUILD_GREETING=hello-from-the-build"
apify call --input '{"password": "hunter2"}'
# the run logs "API_KEY=*********" and "input password=hunter2"
```

On the Apify platform, turn the setting on in the Actor's **Code** > **Environment variables** section
instead of calling the API, and then build again. A later `apify push` keeps it. It passes every custom
variable to the build, `API_KEY` included, and build arguments are not encrypted: keep secrets a build
does not need out of the version when it is on.
