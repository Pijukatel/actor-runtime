# check=skip=FromPlatformFlagConstDisallowed
# ^ BuildKit's linter dislikes a constant `FROM --platform` on principle (it usually defeats
# multi-arch builds); here single-arch is the whole point - see the linux/amd64 comment below -
# so the warning is suppressed rather than shown to every Apple Silicon user as false alarm.
#
# actor-runtime: a minimal, self-contained local Apify platform.
#
# glibc is required, not optional: @crawlee/fs-storage loads a native Rust addon
# (@crawlee/fs-storage-native) with no musl build, so this image cannot be Alpine-based
# (see requirements/system.md and file-system-storage.ts:19-27 in the crawlee v4 source).
#
# linux/amd64 is pinned for the same addon: @crawlee/fs-storage-native publishes bindings only for
# darwin-arm64/darwin-x64/linux-x64-gnu/win32-x64-msvc - no linux-arm64 build exists on npm at all -
# so an arm64 image (Docker Desktop's default on Apple Silicon) dies at startup with "Cannot find
# module '@crawlee/fs-storage-native-linux-arm64-gnu'". Pinning here beats asking every Apple
# Silicon user to remember `docker build --platform ...`: Docker Desktop runs the amd64 image under
# Rosetta, and on amd64 hosts (CI included) the pin is a no-op.
FROM --platform=linux/amd64 node:24-bookworm-slim AS builder

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

# --platform pinned for the same reason as the builder stage - see the comment at the top.
FROM --platform=linux/amd64 node:24-bookworm-slim

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
