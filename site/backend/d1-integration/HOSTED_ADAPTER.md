# Website hosted-adapter contract

The adapter is Website-owned because it controls the real Site, signed-in
browser contexts, DOM and deployment. Backend's runner controls the assertions.
The adapter module exports:

```js
export async function createHostedAcceptanceAdapter({ baseUrl, runNonce, actorContexts }) {
  return {
    async metadata() {},
    async runScenario({ id, challenge }) {},
  };
}
```

`actorContexts` is the exact non-secret descriptor array in
`HOSTED_EVIDENCE_CONTRACT.json`. During factory creation, launch three new
isolated browser storage contexts and pause for interactive sign-in: A in both
A contexts and a distinct B identity in B's context. Resolve the factory only
after server-derived checks establish that the A contexts share ownership and
B does not. Do not consume ambient browser profiles or put credentials,
cookies, tokens, subjects or identities in the adapter bundle, environment,
arguments, evidence or process output. If the contexts cannot be established,
leave acceptance unpassed.

`metadata()` returns:

```js
{
  environment: "website-adapter-attested-private-sites-d1",
  base_url: baseUrl,
  actors: ["a_device_1", "a_device_2", "b_device_1"],
  executed_at: new Date().toISOString(),
  release_pins: { /* every HOSTED_ACCEPTANCE.json required_release_pins key */ },
  run_nonce: runNonce
}
```

The runner does not pass the matrix, scenario assertions or expected values to
the adapter. It supplies a fresh nonce, requires the adapter to echo it, and
accepts only an execution timestamp inside the current run. Every release pin
must match the exact value or narrow format in `HOSTED_ACCEPTANCE.json`;
arbitrary nonempty strings are rejected.

Put one reviewed `.mjs` adapter entry in a dedicated directory with
`HOSTED_ADAPTER_MANIFEST.json`. The manifest uses schema
`meshful-website-hosted-adapter.v1`, records the exact Site source commit,
source-manifest and source-payload hashes, saved-version ID and deployment ID,
names one portable relative `.mjs` entry, and lists all and only files in that
directory. It therefore contains exactly two files: entry and manifest. List
the manifest itself with null bytes/hash. The entry payload fingerprint uses
the same code-unit sorted `sha256 + two spaces + relative path + LF` recipe as
the Backend delivery.

The runner pins the manifest and adapter entry bytes. It does not prove the
entry's transitive module closure, sandbox JavaScript, or prevent a dishonest
adapter from fabricating evidence. Website must separately retain and review
its exact source manifest, build/bundler metadata when applicable, browser and
network trace, and Site saved-version/deployment receipt. Those hashes and IDs
must match both this manifest and `metadata().release_pins`. Treat the adapter
entry as a reviewable harness, not as an independent security boundary.

The runner resolves the reviewed manifest to its canonical path and launches
the adapter with that canonical bundle directory as its working directory.
Symlink aliases therefore cannot change the directory used by relative adapter
operations. All files below the canonical bundle root must still be regular,
declared files; nested symlinks are rejected.

Each actor is a separate real browser context. A1 and A2 authenticate the same
verified account; B authenticates a different verified account. Do not implement
actors by changing an identity header in one fetch function. The adapter may use
Website's existing browser controller and network interception, but it must
exercise the deployed origin and actual bound D1 database.

`runScenario({ id, challenge })` executes the named case and returns an object
containing all and only the flat assertion keys for that case plus
`scenario_id`, `runner_challenge`, `challenge_observed_by_host`,
`network_trace_sha256` and `d1_observation_sha256`. Carry the fresh challenge
through the hosted request/trace correlation and return it only after the host
observes it. Values are bounded primitive
booleans, safe integers or short non-sensitive codes. Extra keys, nested values,
arrays and unsafe strings fail the run. It must not include raw state, answers,
feedback, principal IDs, identity subjects, cookies, tokens, headers or browser
backups. The runner hashes each allowlisted evidence object and prints only that
digest, binding the scenario ID, challenge, release pins and trace/observation
hashes.

Use the exact challenge header, canonical manifest schemas and SHA-256 recipes
in `HOSTED_EVIDENCE_CONTRACT.json`. The challenge must reach the production
learner route and its server trace; a browser-only request ID or locally echoed
value is insufficient. Website retains the canonical network, D1 and resource
manifests beside the deployment receipt. Their digest fields are
`network_trace_sha256`, `d1_observation_sha256` and
`resource_metrics_sha256`. The manifests contain only allowlisted counts,
booleans and digests and never raw learner or identity data.

The current Backend runner checks those digest strings but does not yet open or
canonicalize the retained manifests. Until a successor paired-artifact verifier
cross-links their scenario, challenge, trace and observation fields, this is a
harness receipt only. It reports `paired_artifacts_verified:false`,
`provider_limits_verified:false` and `hosted_acceptance_complete:false`; its
scenario totals are labeled as harness totals. Do not label it final hosted
acceptance. Likewise, bind
every effective resource limit to a retained owner account or deployment-config
receipt; an adapter-reported limit is not provider evidence by itself.

This is an adapter-attested receipt. A local JavaScript adapter can lie, so the
runner deliberately reports `independent_network_proof:false`. Release review
must pair it with the pinned adapter source, a real browser/network trace and
the owner D1 schema/usage observation. The receipt alone never proves a network
request or a hosted database.

For trusted ingress, use the active production route. Exercise a legitimate
Sites-dispatched A request, forged identity headers, Host/header-only requests,
the direct Worker/origin path, and an unknown identity. Also change display
email/name without changing the verified subject and prove no account relink.
Do not implement actors by changing headers in one trusted fetch function.

Run both sign-out branches. In one, let A commit before the response returns;
after A returns, recover the exact receipt without another grade. In the other,
prevent the initial commit, preserve A's original-account pending draft, then
retry it once after A returns. In both branches, retire A's Accounts epoch and
native lease before showing B and prove B's D1 head, outbox and DOM are unchanged.

For the guest claim, the adapter must use the browser controller's preserved
claim slot and a visible explicit confirmation. Hash the original browser-key
bytes before the claim and again after lost-ack retry/reload, reporting only
whether they match. Prove the claim-slot backup remains readable and the same
source cannot be claimed by a second account. The receipt must not contain the
original JSON or either digest.

For Library capacity, install the known 14-deck/1,892-card parent-first closure
as one revision, reload it on A's second device, and replay without another
write. Static catalog counts do not satisfy this case.

Also run the measured 4,523,091-byte native command/6,709,782-byte state through
the real hosted HTTP/D1 path. A real browser draft may either persist or refuse
quota safely; refusal must preserve original-account bytes and does not waive the
server test. Claim the exact 512-history state, reload, grade review 513 and
replay once. Prove every capacity invocation completed without an
`exceededMemory` outcome, record the maximum per-invocation CPU time plus
SQL/row usage and D1 storage growth, and prove missing-base and over-budget
recovery stays exact and untruncated. Return explicit observed and effective
values for CPU, total query count, request body and D1 storage. The runner
compares every observed value to its effective limit. Pin the exact provider
trace/metadata observation in `resource_metrics_sha256` and name its source as
`sites_runtime_and_d1_metadata` or
`cloudflare_worker_trace_and_d1_metadata`. Cloudflare's Worker memory chart is
a sampled invocation distribution shared across concurrent requests; do not
report it as a per-scenario peak. Retain local process profiling separately. If
Sites does not expose a required metric or limit, leave this scenario unpassed;
do not substitute a local Node estimate.

The runner invokes this adapter in a child process with a minimal environment
(`PATH`, `TMPDIR`, and `LANG` only), no inherited `NODE_OPTIONS`/loaders, and
captured stdout/stderr. It rejects any process output without echoing it. This
reduces accidental credential and learner-data exposure; it does not sandbox a
dishonest adapter or its dependencies. Success is decided only after the child
and captured pipes close. The 15-minute timeout rejects immediately, sends
`SIGTERM`, and escalates to `SIGKILL` after a short grace period.

Run the authority process with plain Node and an explicitly removed
`NODE_OPTIONS`, as shown in the README. It rejects a nonempty `NODE_OPTIONS` or
any Node `execArgv` flag so an inherited preload, import hook, loader, inspector
or runtime option cannot be mistaken for the pinned runner. This is a runtime
precondition; the receipt does not certify a compromised host.

For the failed-batch case, use a disposable hosted acceptance account/database
mechanism supported by Website. Never corrupt or delete a real learner's rows to
force a failure. If the managed platform offers no safe injection mechanism,
record this scenario as unpassed rather than substituting the local SQLite
receipt.
