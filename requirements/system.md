# Environment
- Supported operating systems:
  - Linux (tested)
  - MacOS (not tested in POC)
  - Windows. (not tested in POC)

- The system is encapsulated in dedicated docker image.
- Linux is the officially supported and verified platform for the POC.
- MacOS and Windows are best-effort for the POC.

# Components
- The system exposes API that is compliant with the requirements in `api.md`
- The system has very simple frontend that is compliant with the requirements in `console.md`
- The system is using permanent and ephemeral storage based on requirements in `storage.md`
- The system can build and run actors according to the requirements in `actor-driver.md`
- The system is controlled through Apify cli based on the requirements in `cli.md`

# User interface
- The system is isolated environment that is started by running the docker container.
- The system user interface is accessible on localhost with specific ports for console frontend and API.
- The user interacts with the system through the Apify cli.
- When the container is started it prints the relevant user interface ports in console message.
- The API port (3333) and the console frontend port (3000) are fixed values and
  are not configurable; they are the same on every start of the container.

# Scope
- The system is a development tool for developing actors.
- The system is not a production system for hosting actors.

# Scale
The intended scale of the system is:
  - less than 10 built actors
  - less than 5 running actors at the same time
  - less than 100 actor runs
  - less than 100 datasets
  - less than 100 key value stores
  - less than 100 request queues
  - 1 user
The intended scale is not enforced, but the system operating above the intended scale can experience performance or functional issues.

# Tests
The system is tested according to the requirements in `test.md`