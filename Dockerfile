# actor-runtime: a minimal, self-contained local Apify platform.

# --- Python debug-mode payload (`requirements/actor-driver.md`'s "Debug mode" section): a pinned,
# pure-Python debugpy wheel plus `docker/sitecustomize.py`, pre-built into a tar streamed into a Python
# debug run's container at run start via `container.putArchive`.
# `--platform=$BUILDPLATFORM`: this stage's whole output is architecture-independent (a pure-Python
# wheel plus a .py file, tarred), so on a multi-arch build it runs once natively on the builder rather
# than once per target under QEMU. Requires BuildKit, which is the default builder in Docker >= 23.
FROM --platform=$BUILDPLATFORM docker.io/library/python:3.11-slim AS debugpy-payload
ARG DEBUGPY_VERSION=1.8.21
# Must match `services/debug-mode.ts`'s `PYTHON_DEBUG_PAYLOAD_DIR` - the in-Actor-container path the
# tar is extracted to.
ARG PAYLOAD_DIR=opt/apify-debug
WORKDIR /payload
RUN mkdir -p "/payload/root/${PAYLOAD_DIR}"
# Pure-Python wheel only, so the same payload runs unmodified against whatever CPython the Actor's base
# image ships.
RUN pip download --no-deps --only-binary=:all: \
	--python-version 3.11 --implementation py --abi none --platform any \
	"debugpy==${DEBUGPY_VERSION}" -d /tmp/wheel \
	&& python3 -m zipfile -e "/tmp/wheel/debugpy-${DEBUGPY_VERSION}-py2.py3-none-any.whl" "/payload/root/${PAYLOAD_DIR}" \
	&& rm -rf /tmp/wheel
COPY docker/sitecustomize.py /payload/root/${PAYLOAD_DIR}/sitecustomize.py
# World-writable (sticky, like /tmp): extracted into the Actor container as root, but the Actor itself
# commonly runs as a non-root user, who must be able to create `sitecustomize.py`'s start-marker here.
RUN chmod 1777 "/payload/root/${PAYLOAD_DIR}"
# Read back from the extracted package rather than duplicating DEBUGPY_VERSION as a separate constant.
RUN python3 -c "\
import sys; \
sys.path.insert(0, '/payload/root/${PAYLOAD_DIR}'); \
import debugpy._version as v; \
print(v.get_versions()['version'])" > /payload/debugpy-version.txt
RUN tar -cf /payload/debugpy-payload.tar -C /payload/root .

# --- Browser-view sidecar: an Alpine rootfs with x11vnc, tarred so the runtime can `docker import` it at
# run time without a registry. Not pinned to $BUILDPLATFORM: it runs on the Actor containers' daemon, so it
# must be the target architecture's.
FROM docker.io/library/alpine:3.21 AS browser-viewer-rootfs
RUN apk add --no-cache x11vnc
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
COPY docker/browser-viewer.sh /apify-browser-viewer.sh
RUN chmod 755 /apify-browser-viewer.sh

# Tars the stage above and records its content hash, which the runtime uses as the imported image's tag.
FROM --platform=$BUILDPLATFORM docker.io/library/alpine:3.21 AS browser-viewer-payload
COPY --from=browser-viewer-rootfs / /rootfs
RUN mkdir -p /payload \
	&& tar -cf /payload/rootfs.tar -C /rootfs . \
	&& sha256sum /payload/rootfs.tar | cut -c1-16 > /payload/version.txt

# Also architecture-independent: this stage only runs `tsc`, and the `dist/` it hands to the final
# stage is plain JavaScript. The final stage does its own `pnpm install --prod`, so the target
# architecture's native bindings still come from a native (emulated) install there.
FROM --platform=$BUILDPLATFORM docker.io/library/node:24-bookworm-slim AS builder

WORKDIR /usr/src/app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM docker.io/library/node:24-bookworm-slim

WORKDIR /usr/src/app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
# The store prune plays the role `npm cache clean` played before: production node_modules keeps
# hard links into the store, so pruning drops only the unreferenced (dev) packages' disk copies.
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=builder /usr/src/app/dist ./dist

# Shipped in the image so the CLI never carries a copy that can drift from the runtime it talks to.
COPY skills ./skills

# Matches config.ts's debugpyPayloadDir() default.
COPY --from=debugpy-payload /payload/debugpy-payload.tar /opt/apify-debug-payload/debugpy-payload.tar
COPY --from=debugpy-payload /payload/debugpy-version.txt /opt/apify-debug-payload/debugpy-version.txt

# Matches config.ts's browserViewerPayloadDir() default.
COPY --from=browser-viewer-payload /payload/rootfs.tar /opt/apify-browser-viewer/rootfs.tar
COPY --from=browser-viewer-payload /payload/version.txt /opt/apify-browser-viewer/version.txt

# The runtime talks to the host's Docker-Engine-API socket via dockerode (no docker CLI needed in-image;
# Podman's Docker-compatible socket works the same way) and persists all storages under /data - mount
# both when running the container.
VOLUME ["/data"]
ENV ACTOR_RUNTIME_DATA_DIR=/data

# Defaults; ACTOR_RUNTIME_API_PORT / ACTOR_RUNTIME_CONSOLE_PORT move them.
EXPOSE 3333 3000

CMD ["node", "dist/index.js"]
