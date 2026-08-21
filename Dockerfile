# actor-runtime: a minimal, self-contained local Apify platform.
#
# glibc is required, not optional: @crawlee/fs-storage loads a native Rust addon
# (@crawlee/fs-storage-native) with no musl build, so this image cannot be Alpine-based
# (see requirements/system.md and file-system-storage.ts:19-27 in the crawlee v4 source).
FROM node:24-bookworm-slim AS builder

WORKDIR /usr/src/app

# pnpm, not npm - the committed lockfile is pnpm-lock.yaml (see the README's "Package manager"
# section for why). Corepack ships with the node:24 image and installs the exact pnpm version
# pinned by package.json's `packageManager` field; the prompt toggle keeps its one-time
# "download pnpm?" confirmation out of non-interactive builds.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-bookworm-slim

WORKDIR /usr/src/app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The store prune plays the role `npm cache clean` played before: production node_modules keeps
# hard links into the store, so pruning drops only the unreferenced (dev) packages' disk copies.
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=builder /usr/src/app/dist ./dist

# The runtime talks to the host Docker socket via dockerode (no docker CLI needed in-image) and
# persists all storages under /data - mount both when running the container.
VOLUME ["/data"]
ENV ACTOR_RUNTIME_DATA_DIR=/data

EXPOSE 3333 3000

CMD ["node", "dist/index.js"]
