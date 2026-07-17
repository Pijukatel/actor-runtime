FROM python:3.11-slim
WORKDIR /usr/src/app
# Deliberate, human-approved exception to the stdlib-only rule the other
# sample_actor* fixtures follow (see main.py's docstring for the full
# rationale): this fixture exists specifically to prove the real
# apify-client/apify SDK path (success criterion 20), so it pip-installs the
# real, published Apify packages at image BUILD time, when the Docker
# host/CI running the e2e suite has normal internet egress. The container's
# only network use AT RUN TIME is calling the runtime's own API via
# APIFY_API_BASE_URL, so the actor stays deterministic and offline at run time.
# Versions are pinned exactly, like every other dependency in this repo
# (see requirements.txt/requirements-dev.txt), so a future release can't
# silently change the SDK/client behavior this fixture's docstring depends
# on. apify-client is pinned to 2.5.1 rather than its own latest (3.0.x):
# apify==3.4.1 still declares `apify-client>=2.3.0,<3.0.0` in its
# pyproject.toml (apify-client's 3.0.0 was a breaking release the Actor SDK
# hasn't adopted yet as of its latest release), and 2.5.1 is the newest
# apify-client release satisfying that constraint.
RUN pip install --no-cache-dir 'apify-client==2.5.1' 'apify==3.4.1'
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do (see
# sample_actor/.actor/Dockerfile for why this matters).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
