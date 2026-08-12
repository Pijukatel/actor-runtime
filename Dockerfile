# Runtime image for actor-runtime. Talks to the host Docker daemon via the
# mounted socket to build and run Actor images (see README for the docker run
# invocation). Node.js base + dockerode; no Docker CLI needed.
FROM node:22-slim

WORKDIR /app

# HTTPS proxy support for restricted-network builds. These are build-time only
# (ARG, not ENV) so they never leak into the published image. In a normal
# environment they are empty and ignored.
ARG HTTPS_PROXY=
ARG https_proxy=

# package.json/package-lock.json are always copied; ca-bundle.crt is copied
# only if the build context provides one (the [t] glob makes it optional).
# Used to trust a TLS-terminating proxy during npm install.
COPY package.json package-lock.json ca-bundle.cr[t] ./

RUN if [ -f ca-bundle.crt ]; then \
        npm config set cafile /app/ca-bundle.crt; \
    fi; \
    npm ci --omit=dev && \
    npm config delete cafile; \
    rm -f /app/ca-bundle.crt

COPY src ./src

ENV DATA_DIR=/data

EXPOSE 3333 3000

CMD ["node", "src/server.js"]
