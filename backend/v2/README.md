# Meshful Backend v2

This additive successor keeps the v1 identity and migration base while replacing
single-row learner snapshots with bounded, fragmented D1 documents. Apply
`../migrations/0001_learner_data.sql` before
`migrations/0002_fragmented_storage.sql`.

Runtime factories are exported from `src/index.mjs`; browser code imports
`src/durable-client.mjs` directly. The default endpoint prefix is
`/api/learner/v2`.

Provider-free checks from the repository root:

```sh
node backend/v2/scripts/check.mjs
node --test backend/v2/tests/*.test.mjs
MESHFUL_CANONICAL_ROOT="$PWD" MESHFUL_ACCOUNTS_ROOT="$PWD" \
  node --test backend/v2/integration/account-storage.test.mjs \
  backend/v2/integration/capacity.test.mjs
```

The authored `0002` migration includes a deferred composite foreign key and 23
mandatory triggers that are not reproduced by the accompanying Drizzle review
declarations. Do not replace the SQL migration with generated SQL.

These checks establish local mechanics only. Hosted D1 application, trusted
dispatcher ingress, two-device convergence, replay, isolation, sign-out, and
stale-token behavior remain deployment acceptance gates.
