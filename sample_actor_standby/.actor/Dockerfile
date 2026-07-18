FROM python:3.11-slim
WORKDIR /usr/src/app
# Build-time-only network use (see sample_actor/.actor/Dockerfile for the
# full apify/apify-client version-pin rationale). This fixture only serves
# HTTP (via the stdlib's own `http.server`, still no client library needed
# for that); the `apify` SDK is used solely for its own storage push.
RUN pip install --no-cache-dir 'apify-client==2.5.1' 'apify==3.4.1'
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do (see
# sample_actor/.actor/Dockerfile for why this matters).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
