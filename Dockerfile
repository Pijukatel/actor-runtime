# actor-runtime: a minimal, self-contained local Apify platform.

# --- Python debug-mode payload (`requirements/actor-driver.md`'s "Debug mode" section): a pinned,
# pure-Python debugpy wheel plus `docker/sitecustomize.py`, pre-built into a tar the runtime streams into
# a Python debug run's container via `container.putArchive` at run start - built once, here, at image-
# build time, so a debug run needs no network access and the runtime needs no tar library of its own
# beyond what `putArchive` already streams. The ONE place the debugpy version is pinned - the run log's
# attach line (`docker-driver.ts`) reads it back from `debugpy-version.txt` below, never a second,
# independently-hardcoded copy.
FROM python:3.11-slim AS debugpy-payload
ARG DEBUGPY_VERSION=1.8.21
# Matches `services/debug-mode.ts`'s `PYTHON_DEBUG_PAYLOAD_DIR` constant - NOT `config.ts`'s similarly
# named `debugpyPayloadDir()`, which is an unrelated helper for a path inside the RUNTIME's own image
# (`/opt/apify-debug-payload`, where the built tar below is stored before an Actor container ever exists).
# The tar built below is rooted so extracting it at `/` (`docker-driver.ts`'s
# `putArchive(tar, { path: '/' })`) lands the payload at exactly this in-ACTOR-container path, matching
# the `PYTHONPATH` entry a Python debug run's env carries.
ARG PAYLOAD_DIR=opt/apify-debug
WORKDIR /payload
RUN mkdir -p "/payload/root/${PAYLOAD_DIR}"
# The pure-Python `py2.py3-none-any` wheel only, never a platform-specific one - interpreter- and
# arch-independent, so the same payload works unpacked directly against whatever CPython an Actor's own
# base image ships, with no compiled accelerator to rebuild per architecture (pydevd's optional C
# accelerators are simply absent; its pure-Python fallback is what runs).
RUN pip download --no-deps --only-binary=:all: \
	--python-version 3.11 --implementation py --abi none --platform any \
	"debugpy==${DEBUGPY_VERSION}" -d /tmp/wheel \
	&& python3 -m zipfile -e "/tmp/wheel/debugpy-${DEBUGPY_VERSION}-py2.py3-none-any.whl" "/payload/root/${PAYLOAD_DIR}" \
	&& rm -rf /tmp/wheel
COPY docker/sitecustomize.py /payload/root/${PAYLOAD_DIR}/sitecustomize.py
# The version string a debug run's attach log line names - read back by actually importing the payload's
# own extracted `_version.py` (never a second hardcoded copy of `DEBUGPY_VERSION` above).
RUN python3 -c "\
import sys; \
sys.path.insert(0, '/payload/root/${PAYLOAD_DIR}'); \
import debugpy._version as v; \
print(v.get_versions()['version'])" > /payload/debugpy-version.txt
RUN tar -cf /payload/debugpy-payload.tar -C /payload/root .

FROM node:24-bookworm-slim AS builder

WORKDIR /usr/src/app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-bookworm-slim

WORKDIR /usr/src/app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
# The store prune plays the role `npm cache clean` played before: production node_modules keeps
# hard links into the store, so pruning drops only the unreferenced (dev) packages' disk copies.
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=builder /usr/src/app/dist ./dist

# The Python debug-mode payload built above - `config.ts`'s `debugpyPayloadDir()` defaults to exactly
# this path, so the runtime finds it with no further configuration when it runs from this image (and
# fails a Python debug run with a clear message when it doesn't, e.g. `pnpm dev`).
COPY --from=debugpy-payload /payload/debugpy-payload.tar /opt/apify-debug-payload/debugpy-payload.tar
COPY --from=debugpy-payload /payload/debugpy-version.txt /opt/apify-debug-payload/debugpy-version.txt

# The runtime talks to the host Docker socket via dockerode (no docker CLI needed in-image) and
# persists all storages under /data - mount both when running the container.
VOLUME ["/data"]
ENV ACTOR_RUNTIME_DATA_DIR=/data

EXPOSE 3333 3000

CMD ["node", "dist/index.js"]
