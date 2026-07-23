FROM python:3.11-slim
WORKDIR /usr/src/app
# Build-time-only network use (see sample_actor/.actor/Dockerfile for the full
# apify/apify-client version-pin rationale). This Actor additionally needs
# `crawlee[parsel]` for ParselCrawler; apify==4.0.0 constrains its own
# `crawlee` dependency to `>=1.8.0,<2.0.0`, and 1.8.3 is the newest release
# satisfying that (the same version apify-sdk-python's own lockfile pins
# alongside apify==4.0.0).
RUN pip install --no-cache-dir 'apify-client==3.1.0' 'apify==4.0.0' 'crawlee[parsel]==1.8.3'
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do (see
# sample_actor/.actor/Dockerfile for why this matters).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
