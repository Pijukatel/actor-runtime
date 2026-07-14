# Runtime image for actor-runtime. Talks to the host Docker daemon via the
# mounted socket to build and run Actor images (see README for the docker run
# invocation). Python base + the Docker SDK; no Docker CLI needed.
FROM python:3.11-slim

WORKDIR /app

# HTTPS proxy support for restricted-network builds. These are build-time only
# (ARG, not ENV) so they never leak into the published image. In a normal
# environment they are empty and ignored.
ARG HTTPS_PROXY=
ARG https_proxy=

# requirements.txt is always copied; ca-bundle.crt is copied only if the build
# context provides one (the [t] glob makes it optional). Used to trust a
# TLS-terminating proxy during pip install.
COPY requirements.txt ca-bundle.cr[t] ./

RUN if [ -f ca-bundle.crt ]; then \
        export PIP_CERT=/app/ca-bundle.crt REQUESTS_CA_BUNDLE=/app/ca-bundle.crt; \
    fi; \
    pip install --no-cache-dir -r requirements.txt && \
    rm -f /app/ca-bundle.crt

COPY app ./app

ENV DATA_DIR=/data

EXPOSE 3333 3000

CMD ["python", "-m", "app.server"]
