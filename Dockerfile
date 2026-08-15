# actor-runtime: a minimal, self-contained local Apify platform.
#
# glibc is required, not optional: @crawlee/fs-storage loads a native Rust addon
# (@crawlee/fs-storage-native) with no musl build, so this image cannot be Alpine-based
# (see requirements/system.md and file-system-storage.ts:19-27 in the crawlee v4 source).
FROM node:24-bookworm-slim AS builder

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /usr/src/app/dist ./dist

# The runtime talks to the host Docker socket via dockerode (no docker CLI needed in-image) and
# persists all storages under /data - mount both when running the container.
VOLUME ["/data"]
ENV ACTOR_RUNTIME_DATA_DIR=/data

EXPOSE 3333 3000

CMD ["node", "dist/index.js"]
