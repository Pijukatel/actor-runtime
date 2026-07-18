FROM python:3.11-slim
WORKDIR /usr/src/app
# Build-time-only network use: pip-installs the real, published `apify` SDK
# and `apify-client` packages at image BUILD time, when the Docker host/CI
# running the e2e suite has normal internet egress. At RUN time the only
# network use is calling the runtime's own API via APIFY_API_BASE_URL, so the
# actor stays deterministic and offline at run time. Versions are pinned
# exactly, like every other dependency in this repo (see
# requirements.txt/requirements-dev.txt): apify-client is pinned to 2.5.1
# rather than its own latest (3.0.x) because apify==3.4.1 still declares
# `apify-client>=2.3.0,<3.0.0` in its pyproject.toml, and 2.5.1 is the newest
# apify-client release satisfying that constraint.
RUN pip install --no-cache-dir 'apify-client==2.5.1' 'apify==3.4.1'
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do. This ensures
# the e2e test exercises the non-root storage-permission path (a root-only Actor
# would mask a bind-mount permission bug).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
