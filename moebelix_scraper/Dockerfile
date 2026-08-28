# The Actor only uses `apify` and `@crawlee/cheerio`, both of which come preinstalled in the
# apify/actor-node base image (https://docs.apify.com/sdk/js/docs/guides/docker-images), so the
# image is built from the locally compiled `dist/` with no `npm install` at all - the build needs
# no network access and stays fast. Run `npm run build` before `apify push`.
FROM apify/actor-node:24

# Fail the build early if the preinstalled packages this Actor relies on are missing.
RUN npm ls apify @crawlee/cheerio

# package.json is needed at runtime for "type": "module" (dist/main.js is compiled as ESM).
COPY --chown=myuser:myuser package.json ./
COPY --chown=myuser:myuser dist ./dist

# Run the image.
CMD ["node", "dist/main.js"]
