#!/bin/sh
# The Actor's custom entry point: reports the environment it started in, then hands over to the
# command line CMD supplied.
set -eu

echo "launch.sh: entry point running as $0"
echo "launch.sh: working directory $(pwd)"
echo "launch.sh: user id $(id -u)"
echo "launch.sh: handing over to: $*"

exec python3 -u "$@"
