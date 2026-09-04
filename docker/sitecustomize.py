"""Injected via PYTHONPATH by actor-runtime's Python debug-mode payload (see actor-driver.md "Debug
mode"). CPython's `site` module imports this before any user code runs.

Runs in every Python process in the container, not just the Actor's own - an atomic marker-file create
(O_CREAT | O_EXCL) picks the single process that starts debugpy; every other process returns immediately.
The marker lives beside this file, not under /tmp (some Apify base images ship without one).

No synthetic breakpoint after wait_for_client() - the IDE's own attach decides where execution stops.
"""

import os
import sys

_MARKER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.debugpy-started')
_PORT_ENV_VAR = 'APIFY_ACTOR_RUNTIME_DEBUG_PORT'


def _log(message):
    # Runs before the Actor's own logging is set up - write directly to stderr; docker-driver.ts
    # captures both stdout and stderr into the run log.
    print(f'[actor-runtime debug] {message}', file=sys.stderr, flush=True)


def _win_marker_race() -> bool:
    """True if this process should start debugpy - exclusive create avoids a check-then-create race.
    Any error other than FileExistsError falls back to "try anyway" rather than risking a silent
    non-debug start."""
    try:
        fd = os.open(_MARKER_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    except OSError as error:
        _log(f'could not create the debugpy start-marker ({error}); trying to start debugpy anyway')
        return True
    else:
        os.close(fd)
        return True


def _start() -> None:
    port_raw = os.environ.get(_PORT_ENV_VAR)
    if not port_raw:
        # Driver always sets this alongside PYTHONPATH; do nothing if it's missing rather than guess a port.
        return

    try:
        port = int(port_raw)
    except ValueError:
        _log(f'internal error: {_PORT_ENV_VAR}="{port_raw}" is not an integer - not starting debugpy')
        sys.exit(1)

    try:
        import debugpy
    except Exception as error:  # pragma: no cover - the payload always ships debugpy alongside this file
        _log(f'internal error: could not import the injected debugpy ({error})')
        sys.exit(1)

    try:
        debugpy.listen(('0.0.0.0', port))
    except OSError as error:
        # Fallback for a race the marker guard missed - another process likely already bound this port.
        _log(
            f'debugpy could not bind 0.0.0.0:{port} ({error}); assuming another process in this '
            'container already started it - continuing without pausing'
        )
        return
    except Exception as error:
        _log(f'internal error: debugpy.listen() failed ({error})')
        sys.exit(1)

    # The diagnosable "it's alive" signal - its absence means injection failed before printing anything.
    _log(f'debugpy is listening on 0.0.0.0:{port}, waiting for a debugger to attach')

    try:
        debugpy.wait_for_client()
    except Exception as error:
        _log(f'internal error: debugpy.wait_for_client() failed ({error})')
        sys.exit(1)

    _log('a debugger attached - continuing to the Actor\'s own first line')
    # No synthetic breakpoint - control returns to `site`'s import machinery.


if _win_marker_race():
    _start()
