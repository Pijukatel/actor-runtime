"""Injected by actor-runtime's Python debug-mode payload (`requirements/actor-driver.md`'s "Debug mode"
section) - baked into the runtime's own image by `Dockerfile`'s `debugpy-payload` build stage and
uploaded into a Python debug run's container via `container.putArchive` (`docker-driver.ts`), on
`PYTHONPATH` alongside the debugpy package itself. CPython's `site` module imports this automatically,
before any user module runs - including `python3 -m src` (exec-form), a shell-form `CMD`, or a bash
wrapper alike, since `site` processing always happens first, regardless of how the interpreter itself
was invoked.

Guard: this file runs in EVERY Python process in the container, not just the Actor's own - `pip`, a
subprocess the Actor's own code spawns, anything. An atomic,
exclusive marker-file create (`os.O_CREAT | os.O_EXCL`) decides which single process actually starts the
debugpy listener - race-free even if two processes reach this file within the same tick, unlike a
read-then-write check. The marker lives right next to this file (this payload's own directory, on
`PYTHONPATH`), never under `/tmp` - several Apify base images (e.g. `apify/actor-python`) ship with no
`/tmp` directory at all, and this file's own directory is the one path guaranteed to exist, since
injection already had to put THIS file there. Every process that loses the race (the marker already
exists) returns immediately and runs completely normally, with no debugpy involvement at all.

Two independent fallbacks, deliberately layered, so no single unexpected failure here ever leaves the
Actor running silently undebugged (`actor-driver.md`'s "never a silent non-debug start"): (1) if the
marker check itself raises anything other than "already exists" (e.g. the payload directory is
unexpectedly read-only), this process assumes it should still try to start debugpy, rather than
assuming someone else already did; (2) a failed `debugpy.listen()` (address already in use) is then
caught on its own, on the theory that another process genuinely did win a race this guard failed to
prevent. Both fallbacks fail towards "try to pause", never towards "silently don't".

No synthetic breakpoint after `wait_for_client()` (a deliberate choice, documented in
`requirements/actor-driver.md`'s "Debug mode" section): the IDE's own attach is what determines where
execution actually stops - this file only gets the Actor's own first line to wait *before*, never a
frame of its own to show the developer.
"""

import os
import sys

_MARKER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.debugpy-started')
_PORT_ENV_VAR = 'APIFY_ACTOR_RUNTIME_DEBUG_PORT'


def _log(message):
    # This module runs before the Actor's own logging (or even its own imports) is set up, so it writes
    # directly to stderr - `docker-driver.ts` captures both stdout and stderr into the run's log either
    # way. Every branch below prints its own message, so the run log is always self-explaining about
    # exactly which of this file's own steps did (or didn't) happen.
    print(f'[actor-runtime debug] {message}', file=sys.stderr, flush=True)


def _win_marker_race() -> bool:
    """True if THIS process should be the one to start debugpy. Uses an exclusive create so the
    check-and-create is a single atomic syscall, not a check-then-create race. `FileExistsError` means a
    real loss (someone else already won); any OTHER exception falls back to "yes, try anyway" (see the
    module doc comment's two-fallback design) - never to "no", which would risk the Actor running
    completely undebugged with nothing in the log to explain why."""
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
        # Never happens for a genuine debug run - the driver always sets this alongside PYTHONPATH
        # (`services/debug-mode.ts: resolveDebugPlan`). If this file is ever imported without it (e.g.
        # PYTHONPATH leaked into some unrelated container), do nothing rather than guess a port.
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
        # Most likely: another process in this container already bound this port - the marker-file guard
        # above already tries to prevent this, so this branch is the fallback for the case where it
        # couldn't (see the module doc comment). Never this process's own fatal error.
        _log(
            f'debugpy could not bind 0.0.0.0:{port} ({error}); assuming another process in this '
            'container already started it - continuing without pausing'
        )
        return
    except Exception as error:
        _log(f'internal error: debugpy.listen() failed ({error})')
        sys.exit(1)

    # This exact line is the diagnosable "it's alive" signal (`actor-driver.md`'s "Debug mode" section) -
    # its absence from the run log means injection failed before this file printed anything at all,
    # distinguishable from every failure branch above (each of which prints its own message).
    _log(f'debugpy is listening on 0.0.0.0:{port}, waiting for a debugger to attach')

    try:
        debugpy.wait_for_client()
    except Exception as error:
        _log(f'internal error: debugpy.wait_for_client() failed ({error})')
        sys.exit(1)

    _log('a debugger attached - continuing to the Actor\'s own first line')
    # No synthetic breakpoint here - deliberately (see module doc comment). Control now simply returns to
    # `site`'s own import machinery, which proceeds to import the Actor's real entry module.


if _win_marker_race():
    _start()
