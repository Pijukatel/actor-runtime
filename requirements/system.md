# Environment
- Supported operating systems:
  - Linux
  - MacOS
  - Windows.

- The system is encapsulated in dedicated docker image.
- Linux is the officially supported and verified platform for this first draft.
- MacOS and Windows are best-effort: the system mounts the host's Docker socket,
  and Docker socket behavior differs across platforms, so external interface and
  behavior parity there is not guaranteed or verified.
- Cross-platform parity (identical external interface and behavior on Linux,
  MacOS and Windows) remains a long-term goal, not a requirement met by this
  draft.

# Components
- The system exposes API that is compliant with the requirements in `api.md`
- The system has very simple frontend that is compliant with the requirements in `console.md`
- The system is using permanent and ephemeral storage based on requirements in `storage.md`
- The system can build and run actors according to the requirements in `actor-driver.md`

# User interface
- The system is isolated environment that is started by running the docker container.
- The system user interface is accessible on localhost with specific ports for console frontend and API.
- When the container is started it prints the relevant user interface ports in console message.