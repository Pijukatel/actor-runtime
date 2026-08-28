# Möbelix.cz furniture category scraper

Apify Actor that scrapes products from a chosen furniture category on
[moebelix.cz](https://www.moebelix.cz/). For every product in the category it outputs one dataset
item with the name, URL, product id, current/old price, availability, rating, color, image URL and
the category it came from.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `category` | string | Furniture category name as shown on [/c/nabytek](https://www.moebelix.cz/c/nabytek), e.g. `Židle`, `Postele`, `Komody`, `Sedací soupravy`. Matching is case- and diacritics-insensitive, so `zidle` works too. |
| `categoryUrl` | string | Direct category listing URL (e.g. `https://www.moebelix.cz/zidle-C22`). Takes precedence over `category`. |
| `maxItems` | integer | Maximum number of products to scrape (default 60 = one listing page). |
| `maxConcurrency` | integer | Max listing pages fetched in parallel (default 5). |
| `proxyConfiguration` | object | Standard Apify proxy configuration, defaults to `{ "useApifyProxy": true }`. |

## Proxy

moebelix.cz sits behind Cloudflare and blocks plain datacenter IPs, so the Actor needs Apify Proxy.
The proxy password is read from the `APIFY_PROXY_PASSWORD` environment variable by the Apify SDK -
it is **never** hardcoded. On the Apify platform the variable is injected automatically; when
running against the local actor-runtime, start the runtime container with
`-e APIFY_PROXY_PASSWORD` (see the repository README's "Apify Proxy" section) and the runtime
forwards it into the Actor container.

Cloudflare occasionally challenges an individual proxy session with a 403 or a "Just a moment…"
page; the Actor detects both, retires the session, and retries with a fresh one, which passes
virtually always.

## Local development against the actor-runtime

```bash
npm install
npm run build          # compile src/ -> dist/ (the Dockerfile ships dist/, no npm install in-image)
apify push             # with APIFY_CLIENT_BASE_URL / APIFY_CONSOLE_URL pointing at the runtime
apify call --input '{"category":"Židle","maxItems":130}'
```

In a sandbox whose only egress is a TLS-intercepting proxy (so `proxy.apify.com:8000` is
unreachable and direct HTTPS presents an untrusted certificate), run with

```json
{ "category": "Židle", "maxItems": 130, "proxyConfiguration": { "useApifyProxy": false }, "ignoreSslErrors": true }
```

which was verified to scrape the full category through such an egress. On the Apify platform use
the default input (Apify Proxy on, SSL validation on).

## How it works

1. If `categoryUrl` is not given, the Actor opens the category hub `https://www.moebelix.cz/c/nabytek`
   and resolves `category` against the category cards there.
2. Listing pages are server-rendered; the Actor parses the embedded `window.__APOLLO_STATE__`
   (Coveo search results: 60 products per page plus exact pagination info) and falls back to DOM
   product tiles if that state is ever missing.
3. It paginates via `?page=N` until `maxItems` products are collected or the category is exhausted.

## Example

Input:

```json
{ "category": "Židle", "maxItems": 120 }
```

Sample dataset item:

```json
{
	"name": "Otočná židle ZORA",
	"url": "https://www.moebelix.cz/p/otocna-zidle-zora-000788009601",
	"productId": "000788009601",
	"price": 2199,
	"currency": "CZK",
	"oldPrice": 3999,
	"availability": "ONLINEAVAILABLE",
	"averageRating": null,
	"numberOfReviews": null,
	"color": "černá",
	"freeDelivery": false,
	"imageUrl": "https://media.moebelix.com/i/moebelix/PIVlDH6RoxFCt9QC3jgzohsw",
	"category": "Židle",
	"categoryUrl": "https://www.moebelix.cz/zidle-C22",
	"listingPage": 1
}
```
