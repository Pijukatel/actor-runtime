# Deliberately unlike anything `apify create` produces: a stock Python image (no Apify SDK, no
# pre-made user or working directory), an unusual WORKDIR, the Actor's own non-root user, and a
# working-directory-relative entry point taking the real command line from CMD.
#
# The image reference stays short on purpose - the runtime qualifies it, which is what makes the
# build work on Podman too.
FROM python:3.11-slim

RUN useradd --create-home --uid 1500 weirduser

WORKDIR /opt/weird-app

COPY app ./app
COPY launch.sh ./launch.sh

RUN chmod 0755 ./launch.sh && chown -R weirduser:weirduser /opt/weird-app

USER weirduser

ENTRYPOINT ["./launch.sh"]
CMD ["app/main.py"]
