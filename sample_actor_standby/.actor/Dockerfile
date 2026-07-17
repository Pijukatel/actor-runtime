FROM python:3.11-slim
WORKDIR /usr/src/app
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do (see
# sample_actor/.actor/Dockerfile for why this matters).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
