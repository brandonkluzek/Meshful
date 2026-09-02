# D1 and account activation

The source declares the logical Sites binding `DB`. Both authored migrations
are in `site/drizzle/` and mirror their Backend sources exactly.

Account mode activates only when the hosted runtime provides:

```text
MESHFUL_ACCOUNT_SYNC=enabled
MESHFUL_ALLOWED_ORIGIN=https://<exact-approved-host>
```

The origin must be one exact HTTPS origin with no path, query, credentials, or
fragment. The route binds trusted provenance to the in-process `Request` object;
Accounts still validates dispatcher-owned identity headers and same-origin
write requests. Missing D1, activation, or origin returns
`ACCOUNT_SYNC_DISABLED` and does not select a signed-in browser-local fallback.

These values are deployment configuration, not secrets committed to this
repository. Configuring them is not evidence that hosted acceptance passed.
