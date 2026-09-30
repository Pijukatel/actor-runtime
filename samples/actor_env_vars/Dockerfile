FROM docker.io/library/alpine:3.21

# Build arguments carry the version's environment variables only with `applyEnvVarsToBuild` on.
ARG BUILD_GREETING
RUN test -n "$BUILD_GREETING" || { echo "BUILD_GREETING is not set - turn on applyEnvVarsToBuild"; exit 1; }
RUN echo "Build: BUILD_GREETING=$BUILD_GREETING"

# The secret's value is never logged, only whether it arrived.
CMD ["sh", "-c", "echo \"Run: RUN_GREETING=$RUN_GREETING\"; if [ -n \"$API_KEY\" ]; then echo \"Run: API_KEY is set (${#API_KEY} characters)\"; else echo 'Run: API_KEY is not set'; fi"]
