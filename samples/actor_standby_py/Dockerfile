FROM apify/actor-python:3.13

COPY --chown=myuser:myuser requirements.txt ./
RUN pip install -r requirements.txt

COPY --chown=myuser:myuser . ./

CMD ["python3", "-m", "src"]
