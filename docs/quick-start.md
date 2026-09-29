# Quick start

Learn how to build, run, and inspect [Actors](https://docs.apify.com/actors) on your own machine with the local Actor runtime.

The runtime is a single container that emulates the parts of the Apify platform the development loop needs. You use the same Apify CLI commands as against the platform, but builds and runs happen on your computer and no platform compute is used. It is a development tool, not a place to host Actors.

## Before you start

- **Install a container engine.** [Docker](https://docs.docker.com/get-docker/) or [Podman](https://podman.io/docs/installation), running. The CLI takes the first one on your `PATH`; set `APIFY_CONTAINER_ENGINE=podman` to choose.
- **Install the Apify CLI from the `runtime` channel.** The `apify runtime` commands are still in preview:

    ```
    npm install -g apify-cli@runtime
    apify --version
    ```

    The version must read `1.10.1-runtime.x ... installed via npm`.

<details>
<summary>It reports an older version, or <code>Error: Command runtime not found</code></summary>

Your shell is resolving a different `apify`. The bundle installer puts one in `~/.local/bin` and Homebrew in its own prefix; `npm install -g` replaces neither. Run `hash -r`, or open a new terminal. `which -a apify` shows which copy wins.

A local install avoids the clash and leaves your stable `apify` alone:

```
npm install apify-cli@runtime
./node_modules/.bin/apify --version
```

</details>

## 1. Start the runtime

```
apify runtime install
apify runtime start --detach
```

`install` pulls `apify/actor-runtime:latest`, or a tag you name. `start` publishes the API on port `3333` and the console on port `3000`, and keeps data in `~/.apify/actor-runtime/data` unless `--data-dir` says otherwise.

Both ports and the container name are fixed, so only one runtime runs at a time. It serves as many Actors as you like.

### Check that it is running

```
apify runtime status
```

It prints the image, data directory, ports, and which API your CLI talks to, and exits `1` when the runtime is down.

## 2. Point the Apify CLI at the runtime

```
apify runtime connect
```

Every Apify CLI command now goes to the runtime, in every terminal, until `apify runtime disconnect`. Your login is untouched.

The setting is global to your machine - there is no per-project scope and no named profiles. To aim a single shell instead, set these, which take precedence over `connect`:

```
export APIFY_CLIENT_BASE_URL=http://localhost:3333
export APIFY_CONSOLE_URL=http://localhost:3000
```

If you are not logged in already, any non-empty token will do - the runtime does not check it against a real account:

```
apify login --token local-dev-token
```

## 3. Push and run your Actor

No Actor yet? Create one with [`apify create`](https://docs.apify.com/cli/docs/quick-start), or use `samples/actor_ts` from this repository.

1. Navigate to your Actor directory:

    ```
    cd your-actor-name
    ```

2. Push the Actor:

    ```
    apify push
    ```

    The first build takes about a minute; later ones reuse the engine's layer cache. Pushing unmodified source again is refused - use `apify push --force`.

3. Compile the Actor, if your language needs it:

    ```
    npm install && npm run build
    ```

    Skip this only for Python and plain JavaScript. Your push registered this directory as the Actor's [dev folder](#5-edit-your-actors-code-without-rebuilding), and runs mount it over the built image, hiding the `dist/` the build produced. Without a local `dist/`, the first run fails with `Cannot find module '/usr/src/app/dist/main.js'`.

4. Run the Actor:

    ```
    apify call
    ```

    Pass input with `--input '{"key": "value"}'`, or `--input-file input.json` to read it from a JSON file. The CLI streams the log and prints the run's storage ids.

Lines the runtime itself wrote carry a blue `[actor-runtime]` prefix. Your Actor's output is passed through untouched.

> `apify run` still executes your Actor as a plain local process, with no container around it. Use `apify call` for anything that should behave like the platform.

## 4. View the results

Open the console at [http://localhost:3000](http://localhost:3000), or use the ids `apify call` printed:

| Command                                                  | Shows                                  |
| -------------------------------------------------------- | -------------------------------------- |
| `apify runs ls`                                          | Every run of the Actor                 |
| `apify runs log <runId>`                                 | The run log                            |
| `apify datasets info <datasetId>`                        | Dataset metadata, including item count |
| `apify datasets get-items <datasetId> --format json`     | Dataset items                          |
| `apify api v2/key-value-stores/<storeId>/records/OUTPUT` | One key-value store record             |

`apify api` reaches every endpoint the runtime implements. The raw files are in the data directory - read them freely, but change state through the API.

## 5. Edit your Actor's code without rebuilding

Your first `apify push` registers the pushed directory as the Actor's **dev folder**, and every later run mounts it over the built image. Edit, recompile locally, and call again - no push, no build:

```
npm run build
apify call
```

- Edits apply to the **next** run, not one already in progress.
- `node_modules` comes from the built image, so a change to `package.json` or `requirements.txt` needs `apify push --force`.
- `apify call --no-dev-folder` runs from the built image alone, once, leaving the registration in place.
- Register another folder with `apify api POST /actor-runtime/dev-folder/<actorId> --body '"/abs/path"'`, or clear it with `--body '""'`. The Actor's console page has the same field.

The path is resolved on the machine your container engine runs on, which under `podman machine` or Docker Desktop is not your own filesystem.

## 6. Stop the runtime

- **Stop:** `apify runtime stop`, or Ctrl+C if you started it in the foreground.
- **Keep your data:** start again with the same data directory.

## Next steps

- Read the runtime's own reference for IDE debugging, browser view, migration testing, and platform fallback: `apify runtime skill`, or `apify runtime skill --install` to install it as an Agent Skill. A running runtime also serves it at `http://localhost:3333/actor-runtime/skill`.
- For every CLI command, see the [command reference](https://docs.apify.com/cli/docs/reference).
- For the runtime's exact behaviour, see `requirements/*.md` in this repository.
