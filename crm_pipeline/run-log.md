# Proof run

One passing `import-supervisor` run on the local Actor runtime, from freshly pushed builds of all
four Actors (no dev-folder bind mounts). Input: `{"seed":20240301}`.

- supervisor run `l1e0HL7ndCmBBC2dJ`: `SUCCEEDED`, exit code 0
- region 7 tripped the circuit breaker on attempt 1 (7.34% malformed > 5.00%) and was relaunched
  with `force=true` on attempt 2, which succeeded
- the log ends with `RECONCILIATION PASS`, which is also the run's terminal status message

Resulting storages:

| storage          | kind                  | contents                                  |
| ---------------- | --------------------- | ----------------------------------------- |
| `crm-exports`    | named key-value store | `region-1..8.csv`, `expected-report.json` |
| `crm-normalized` | named dataset         | 38 178 items                              |
| `crm-quarantine` | named dataset         | 1 822 items                               |
| `crm-master`     | named dataset         | 34 493 items                              |

38 178 + 1 822 = 40 000 rows, exactly what the simulator generated.

## Supervisor log

```
INFO  System info {"apifyVersion":"3.7.2","apifyClientVersion":"2.25.0","crawleeVersion":"3.18.1","osType":"Linux","nodeVersion":"v24.19.0"}
INFO  Reset named dataset "crm-normalized" (dropped thmse4iJBMUze2efr).
INFO  Reset named dataset "crm-quarantine" (dropped br4WEZQcM0rNKdo1p).
INFO  Reset named dataset "crm-master" (dropped VnM2TdZWcCTmBXSAn).
INFO  simulator: started run tiuCwcWZJhA4Ggq3D of export-simulator with input {"seed":20240301}.
INFO  simulator: run tiuCwcWZJhA4Ggq3D is RUNNING.
INFO  simulator: run tiuCwcWZJhA4Ggq3D is SUCCEEDED.
INFO  export-simulator finished: the eight regional exports are in "crm-exports".
INFO  Importing regions 1, 2, 3, 4, 5, 6, 7, 8 with max 4 concurrent runs.
INFO  Worker 1 picked up region 1 (7 region(s) still queued).
INFO  Worker 2 picked up region 2 (6 region(s) still queued).
INFO  Worker 3 picked up region 3 (5 region(s) still queued).
INFO  Worker 4 picked up region 4 (4 region(s) still queued).
INFO  region 2 attempt 1/3: started run UenYnpvFYZqvarYcB of region-importer with input {"region":2,"force":false}.
INFO  region 3 attempt 1/3: started run MboJBN63pP1IVQpCc of region-importer with input {"region":3,"force":false}.
INFO  region 1 attempt 1/3: started run NuRYOqiIuLK5su5eH of region-importer with input {"region":1,"force":false}.
INFO  region 4 attempt 1/3: started run 48QFwDjAhJXUxZy7k of region-importer with input {"region":4,"force":false}.
INFO  region 1 attempt 1/3: run NuRYOqiIuLK5su5eH is RUNNING.
INFO  region 4 attempt 1/3: run 48QFwDjAhJXUxZy7k is RUNNING.
INFO  region 3 attempt 1/3: run MboJBN63pP1IVQpCc is RUNNING.
INFO  region 2 attempt 1/3: run UenYnpvFYZqvarYcB is RUNNING.
INFO  region 3 attempt 1/3: run MboJBN63pP1IVQpCc is SUCCEEDED.
INFO  region 3 attempt 1/3: SUCCEEDED (force=false).
INFO  Worker 3 picked up region 5 (3 region(s) still queued).
INFO  region 2 attempt 1/3: run UenYnpvFYZqvarYcB is SUCCEEDED.
INFO  region 2 attempt 1/3: SUCCEEDED (force=false).
INFO  Worker 2 picked up region 6 (2 region(s) still queued).
INFO  region 5 attempt 1/3: started run PZQ2dN2GV0ir56KLd of region-importer with input {"region":5,"force":false}.
INFO  region 6 attempt 1/3: started run kb02FXf2F5UmSuumE of region-importer with input {"region":6,"force":false}.
INFO  region 5 attempt 1/3: run PZQ2dN2GV0ir56KLd is RUNNING.
INFO  region 6 attempt 1/3: run kb02FXf2F5UmSuumE is RUNNING.
INFO  region 1 attempt 1/3: run NuRYOqiIuLK5su5eH is SUCCEEDED.
INFO  region 1 attempt 1/3: SUCCEEDED (force=false).
INFO  Worker 1 picked up region 7 (1 region(s) still queued).
INFO  region 4 attempt 1/3: run 48QFwDjAhJXUxZy7k is SUCCEEDED.
INFO  region 4 attempt 1/3: SUCCEEDED (force=false).
INFO  Worker 4 picked up region 8 (0 region(s) still queued).
INFO  region 7 attempt 1/3: started run 1a93WxNR6qux2wwKC of region-importer with input {"region":7,"force":false}.
INFO  region 8 attempt 1/3: started run HOuTGCL3Hye0GAqLx of region-importer with input {"region":8,"force":false}.
INFO  region 8 attempt 1/3: run HOuTGCL3Hye0GAqLx is RUNNING.
INFO  region 7 attempt 1/3: run 1a93WxNR6qux2wwKC is RUNNING.
INFO  region 7 attempt 1/3: run 1a93WxNR6qux2wwKC is FAILED.
WARN  region 7 attempt 1/3: run 1a93WxNR6qux2wwKC ended FAILED. The importer reported -> ERROR CIRCUIT BREAKER: region 7 has a malformed row rate of 7.34%, above the 5.00% threshold. Nothing was written; re-run with force=true to import anyway.
WARN  Relaunching region 7 with force=true (attempt 2 of 3).
INFO  region 7 attempt 2/3: started run FUexOkSGHjgHmOwF5 of region-importer with input {"region":7,"force":true}.
INFO  region 7 attempt 2/3: run FUexOkSGHjgHmOwF5 is RUNNING.
INFO  region 5 attempt 1/3: run PZQ2dN2GV0ir56KLd is SUCCEEDED.
INFO  region 5 attempt 1/3: SUCCEEDED (force=false).
INFO  region 6 attempt 1/3: run kb02FXf2F5UmSuumE is SUCCEEDED.
INFO  region 6 attempt 1/3: SUCCEEDED (force=false).
INFO  region 8 attempt 1/3: run HOuTGCL3Hye0GAqLx is SUCCEEDED.
INFO  region 8 attempt 1/3: SUCCEEDED (force=false).
INFO  region 7 attempt 2/3: run FUexOkSGHjgHmOwF5 is SUCCEEDED.
INFO  region 7 attempt 2/3: SUCCEEDED (force=true).
INFO  All 8 regions SUCCEEDED. Regions that needed a forced retry: 7.
INFO  reporter: started run HYRtO0qHA8eWwXhM0 of reconciliation-reporter with input {"regionsRetried":[7]}.
INFO  reporter: run HYRtO0qHA8eWwXhM0 is RUNNING.
INFO  reporter: run HYRtO0qHA8eWwXhM0 is SUCCEEDED.
INFO  Expected (ground truth): {"totalRows":40000,"imported":38178,"quarantinedByReason":{"malformed_row":1357,"missing_id":47,"invalid_email":172,"invalid_phone":113,"invalid_date":133},"duplicatesMerged":3685,"uniqueContacts":34493}
INFO  Actual (reconciliation-reporter OUTPUT): {"totalRows":40000,"imported":38178,"quarantinedByReason":{"malformed_row":1357,"missing_id":47,"invalid_email":172,"invalid_phone":113,"invalid_date":133},"duplicatesMerged":3685,"uniqueContacts":34493,"regionsRetried":[7]}
INFO  RECONCILIATION PASS
INFO  [Status message]: RECONCILIATION PASS
```
