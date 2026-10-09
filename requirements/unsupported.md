# Unsupported platform behavior

The runtime emulates the subset of the Apify platform needed for the local Actor development loop
(`system.md`'s Scope). This file lists the user-facing platform behavior that is **not supported or
emulated** at all, as short statements of intent rather than specifications. Behavior that _is_
emulated but differs from the platform in detail stays documented next to the feature it belongs to
(`storage.md`'s "Known differences from the Apify platform", `api.md`'s `501` list).

An unsupported API call answers `501`/`404` locally (`api.md`), or - with the opt-in upstream fallback
enabled - is relayed to the real platform. Relaying is not emulation: the behavior then happens in the
real account, not in the runtime.

## Running Actors

- Multi-tenant Actor Standby, Standby for tasks, and Standby's Console-auth and tokenless options
- Metamorph
- Restart on error
- Result cap (`maxItems`)
- Ad-hoc webhooks on run start
- Metered usage other than compute units: storage operations, data transfer and proxy
- Billing: a run's charges and costs are reported, never invoiced or paid out
- Limited-permission Actors and per-run scoped tokens
- Automatic run and build retention
- Running Actors from the console

## Building and publishing Actors

- Building from Git repository, archive or Gist
- Build on push (Git integration)
- Generated per-build OpenAPI definition
- Output, key-value store and web server schemas
- Publishing to Apify Store
- Actor monetization other than pay-per-event pricing (`actor-driver.md`): rental, pay per result, and the
  Store-side flows (payouts, pricing-change notifications, per-tier prices above the lowest paid tier)
- Actor status, deprecation and maintenance notices
- README, changelog, categories and SEO metadata

## Automation and integrations

- Tasks (saved input configurations)
- Schedules
- Webhooks and webhook dispatches
- Actor-to-Actor integrations
- Integrations (Slack, Gmail, Drive, GitHub, Zapier, Make)
- Run notifications (email, Slack)
- Monitoring and alerting
- Apify MCP server and MCP connectors

## Storage

- Dataset export formats (CSV, XLSX, XML, HTML, RSS, JSONL)
- Dataset views, schema validation and field statistics
- Key-value store schema and collections
- Bulk key-value store download (zip)
- Public and signed storage URLs
- Sharing runs and storages (`generalAccess`, access rights)
- Unnamed and shared storage listing filters
- Storage retention and expiry
- Request queue locking and request deletion (`storage.md`)

## Account and platform

- Apify Store (browsing and running public Actors)
- Actor issues, reviews and quality score
- Organizations, teams and access rights
- Account usage, limits and billing
- Multiple, scoped and expiring API tokens
- Apify Proxy emulation (real proxy used when password known)
- OAuth connections for Actors
- Legacy `/v2/acts` API paths (older clients)
- Unauthenticated reads of public resources

## Console

- Input editor and run start from the console
- Run charts
- Output tab, storage export and download
- Login, account, token and billing settings
- Actor insights, analytics and monitoring
- Per-user scoping (`console.md`)

## Inside the Actor container

- Run metadata env vars (input key, build, task, user, timestamps)
- Apify Proxy env vars other than the password (hostname, port, status URL)
- Log rate limiting, line truncation and size cap
- Legacy `cpuInfo` events

## Platform limits not enforced

- Memory steps and bounds (128 MB - 32 GB, powers of two); a run asking for anything else is warned
  about in its log and started with it anyway
- Run disk limit (`diskMbytes`)
- Record, item and input size limits
- Concurrent run, rate and per-account quotas
- Process, file-descriptor and shared-memory limits
- Network isolation of Actor containers
