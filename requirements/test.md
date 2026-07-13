# Mandatory end-to-end tests
## Actor full dev loop 
Test case must verify full Actor development flow:
 - Create Actor using [apify cli](https://docs.apify.com/cli/docs) and push it to the local actor runtime
 - Build the pushed Actor in local actor runtime
 - Run Actor in local actor runtime
 - Get results when Actor run finishes
 - Fetch all default storages of this Actor run:
   - key value store
   - dataset
   - request queue

## CLI redirect mechanism (confirmed)
The test points the stock `apify-cli` at the local runtime by exporting
`APIFY_CLIENT_BASE_URL=<runtime API URL>` together with a dummy `APIFY_TOKEN`
(see `cli.md`). `apify push` performs both the push and the build; `apify call`
starts and waits for the run. No CLI patch is needed.
