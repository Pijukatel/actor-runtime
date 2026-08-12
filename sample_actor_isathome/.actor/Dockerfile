FROM node:22-alpine
WORKDIR /usr/src/app
# Build-time-only network use: npm-installs the real, published `apify` SDK
# at image BUILD time, when the Docker host/CI running the e2e suite has
# normal internet egress. At RUN time the only network use is calling the
# runtime's own API via APIFY_API_BASE_URL, so the actor stays deterministic
# and offline at run time. The version is pinned exactly in package.json.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do. This
# ensures the e2e test exercises the non-root storage-permission path (a
# root-only Actor would mask a bind-mount permission bug). The `node` user in
# the official Node images is uid 1000.
USER node
CMD ["node", "main.js"]
