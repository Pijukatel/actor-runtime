# Mandatory end-to-end tests
- All end-to-end tests can use only Apify cli commands to emulate user workflow.
- For asserting the test results, the tests must in inspect the return values of the Apify cli commands.
 
## Actor full dev loop 
Test case must verify full Actor development flow:
 - Use sample actors (one for TypeScript actor and one Python actor)
 - Push and build Actor in local actor runtime `apify push`
 - Run Actor in local actor runtime with arguments and get results when it is finished `apify call --input ...`
 - Get and inspect results when Actor run finishes (assert results in default dataset) `apify datasets info {default dataset ID}`
