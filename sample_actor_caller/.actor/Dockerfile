FROM python:3.11-slim
WORKDIR /usr/src/app
# Build-time-only network use (see sample_actor/.actor/Dockerfile for the
# full apify/apify-client version-pin rationale). This fixture also installs
# `httpx` explicitly for the one non-storage HTTP call it makes (to the
# standby Actor's own HTTP server, which is not this runtime's API) --
# `httpx` is NOT a transitive dependency of `apify==4.0.0`/
# `apify-client==3.1.0` (that pair uses `impit` internally too), so it is
# pinned and installed here directly rather than assumed to come along for
# free.
RUN pip install --no-cache-dir 'apify-client==3.1.0' 'apify==4.0.0' 'httpx==0.28.1'
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do (see
# sample_actor/.actor/Dockerfile for why this matters).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
