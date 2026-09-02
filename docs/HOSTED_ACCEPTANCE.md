# Hosted acceptance gates

Do not call the release ready while `d1` is null, the signed-in endpoint returns
`ACCOUNT_SYNC_DISABLED`, signed-in state is browser-local, or the deployed
source revision differs from the approved commit.

Required hosted evidence:

1. Public signed-out judge access loads the guest app without credentials.
2. `DB` is a real Sites-owned D1 binding and migrations `0001` then `0002` are
   applied unchanged, including the deferred foreign key and 23 v2 triggers.
3. The exact HTTPS origin and account activation value are configured through
   the hosted runtime; arbitrary client headers cannot create trusted ingress.
4. A newly authenticated identity receives an empty account and an opaque,
   owner-scoped binding. Another identity cannot read, mutate, replay, or infer it.
5. Existing guest data is never imported automatically or merged. The UI asks
   for explicit confirmation, only an empty destination accepts the copy, and
   the original local bytes remain after success or failure.
6. Two real devices converge on the same deck, session, grade, due time, history,
   and revision after reload.
7. Retrying one command or replaying one request commits exactly once; stale
   revisions fail without silent overwrite.
8. Sign-out immediately revokes the visible account and old callbacks. A stale
   token, old tab, or account switch cannot reveal or mutate prior-account data.
9. The deployed source revision, file manifest, content manifest, visible app,
   demo video, and submitted URLs describe the same frozen experience.

Retain exact request/response and deployment receipts without learner content or
credentials. Local fixtures, synthetic ingress markers, and owner-only hosts do
not satisfy these gates.
