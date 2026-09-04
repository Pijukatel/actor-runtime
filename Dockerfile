# actor-runtime: a minimal, self-contained local Apify platform.

# --- Python debug-mode payload (`requirements/actor-driver.md`'s "Debug mode" section): a pinned,
# pure-Python debugpy wheel plus `docker/sitecustomize.py`, pre-built into a tar streamed into a Python
# debug run's container at run start via `container.putArchive`.
FROM python:3.11-slim AS debugpy-payload
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
# Read back from the extracted package rather than duplicating DEBUGPY_VERSION as a separate constant.
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

# Matches config.ts's debugpyPayloadDir() default.
COPY --from=debugpy-payload /payload/debugpy-payload.tar /opt/apify-debug-payload/debugpy-payload.tar
COPY --from=debugpy-payload /payload/debugpy-version.txt /opt/apify-debug-payload/debugpy-version.txt

# The runtime talks to the host Docker socket via dockerode (no docker CLI needed in-image) and
# persists all storages under /data - mount both when running the container.
VOLUME ["/data"]
ENV ACTOR_RUNTIME_DATA_DIR=/data

EXPOSE 3333 3000

CMD ["node", "dist/index.js"]
