# The apify/actor-node base image already ships the Apify SDK, so this Actor needs no
# install step at all - it is plain ESM JavaScript running on the preinstalled dependencies.
FROM apify/actor-node:24

COPY package.json ./
COPY src ./src

CMD ["node", "src/main.js"]
