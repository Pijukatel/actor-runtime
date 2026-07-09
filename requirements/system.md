# Environment
- Supported operating systems:
  - Linux
  - MacOS
  - Windows. 

- The system can run on all supported operating systems.
- The system external interface and behavior is exactly the same on all supported operating systems.
- The system is encapsulated in dedicated docker image.

# Components
- The system exposes API that is compliant with the requirements in `api.md`
- The system has very simple frontend that is compliant with the requirements in `console.md`
- The system is using permanent and ephemeral storage based on requirements in `storage.md`
- The system can build and run actors according to the requirements in `actor-driver.md`

# User interface
- The system is isolated environment that is started by running the docker container.
- The system user interface is accessible on localhost with specific ports for console frontend and API.
- When the container is started it prints the relevant user interface ports in console message.