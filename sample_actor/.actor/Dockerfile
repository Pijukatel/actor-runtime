FROM python:3.11-slim
WORKDIR /usr/src/app
COPY . ./
# Run as a non-root user, like the real Apify Actor base images do. This ensures
# the e2e test exercises the non-root storage-permission path (a root-only Actor
# would mask a bind-mount permission bug).
RUN useradd -m -u 1000 apify
USER apify
CMD ["python", "main.py"]
