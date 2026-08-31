# Specify the base Docker image. See https://docs.apify.com/sdk/python/docs/overview/getting-started
FROM apify/actor-python:3.13

COPY --chown=myuser:myuser requirements.txt ./

RUN echo "Python version:" \
    && python --version \
    && echo "Pip version:" \
    && pip --version \
    && echo "Installing dependencies:" \
    && pip install -r requirements.txt \
    && echo "All installed Python packages:" \
    && pip freeze

COPY --chown=myuser:myuser . ./

CMD ["python3", "-m", "src"]
