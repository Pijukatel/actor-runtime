FROM python:3.11-slim
WORKDIR /usr/src/app
# Build-time-only network use: pip-installs the real, published `apify` SDK
# and `apify-client` packages at image BUILD time, when the Docker host/CI
# running the e2e suite has normal internet egress. At RUN time the only
# network use is calling the runtime's own API via APIFY_API_BASE_URL, so the
# actor stays deterministic and offline at run time. Versions are pinned
# exactly, like every other dependency in this repo (see
# requirements.txt/requirements-dev.txt): apify==4.0.0 is the SDK's released
# v4 line, and apify-client is pinned to 3.1.0 because apify==4.0.0 declares
# `apify-client[brotli]<4.0.0,>=3.1.0` in its own wheel metadata, and 3.1.0 is
# the newest apify-client release satisfying that constraint (also the newest
# apify-client release overall). The `[brotli]` extra is what pulls the
# `brotli` package into these containers -- no Dockerfile installs it
# directly, and the runtime's own brotli-decompression path (responses.py)
# depends on it landing here.
RUN pip install --no-cache-dir 'apify-client==3.1.0' 'apify==4.0.0'
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do. This ensures
# the e2e test exercises the non-root storage-permission path (a root-only Actor
# would mask a bind-mount permission bug).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
