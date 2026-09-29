# Ships Chromium, Playwright, and an Xvfb entrypoint, so a headful browser works with no display of its own.
# You can see the Docker images from Apify at https://hub.docker.com/r/apify/.
FROM apify/actor-python-playwright:3.14-1.61.0

USER myuser

# Second, copy just requirements.txt into the Actor image,
# since it should be the only file that affects the dependency install in the next step,
# in order to speed up the build
COPY --chown=myuser:myuser requirements.txt ./

# Install the packages specified in requirements.txt,
# Print the installed Python version, pip version
# and all installed packages with their versions for debugging
RUN echo "Python version:" \
 && python --version \
 && echo "Pip version:" \
 && pip --version \
 && echo "Installing dependencies:" \
 && pip install -r requirements.txt \
 && echo "All installed Python packages:" \
 && pip freeze

# Next, copy the remaining files and directories with the source code.
# Since we do this after installing the dependencies, quick build will be really fast
# for most source file changes.
COPY --chown=myuser:myuser . ./

# Use compileall to ensure the runnability of the Actor Python code.
RUN python -m compileall -q my_actor/

# Specify how to launch the source code of your Actor. `python` directly, so actor-runtime's debug mode can attach.
CMD ["python", "-m", "my_actor"]
