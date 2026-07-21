FROM python:3.11-slim
WORKDIR /usr/src/app
# Build-time-only network use (see sample_actor/.actor/Dockerfile for the
# full apify/apify-client version-pin rationale). This fixture's own network
# round trip at run time is `Actor.new_client().user("me").get()`, calling
# back into the runtime's own API via APIFY_API_BASE_URL -- same as every
# other fixture, not a new exception.
RUN pip install --no-cache-dir 'apify-client==3.1.0' 'apify==4.0.0'
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do (see
# sample_actor/.actor/Dockerfile for why this matters).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
