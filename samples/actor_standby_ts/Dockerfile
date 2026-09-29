FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package*.json ./
RUN npm install --include=dev --audit=false

COPY --chown=myuser:myuser . ./
RUN npm run build

FROM apify/actor-node:24

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && rm -r ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist
COPY --chown=myuser:myuser . ./

# The interpreter itself, not `npm start`, so the runtime's debug mode can attach too.
CMD ["node", "dist/main.js"]
