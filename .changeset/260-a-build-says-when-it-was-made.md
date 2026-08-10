---
"@pithy-sh/core": patch
---

A control-plane response says which build answered **and when that build was made**.

`workerVersion` read the `id` off `CF_VERSION_METADATA` and dropped the rest, and the module docstring described a binding with two fields. Measured against a real `wrangler dev`, it has three: `{ id, tag, timestamp }`, every value a string, `timestamp` an ISO-8601 instant. `workerVersionMetadata` now reads all of it; `workerVersion` is its `id` and keeps its shape, because four callers hold that shape and every one of them wants a single opaque string.

The seam stamps a second header, `pithy-worker-version-created`, beside the existing one. Two headers rather than a richer value in the first: a client already deployed compares that whole string, so folding a field into it would make a kit upgrade read as a version change that never happened. With both, a client tells a newer build from an **older one deployed again** — a rollback, which the id alone could only report as an opaque change.

**Absence stays silence.** A field the binding did not carry stamps no header, and a `timestamp` that is not a parseable instant is reported as absent rather than relayed — a client subtracts these, and `NaN` compares false against everything, so garbage would read as "not newer", which is silently the same answer as "unchanged". One gate states it: everything the seam says about the running build is a value the platform handed this Worker, byte for byte.

One case remains outside any header's reach, and is documented rather than papered over: a deployment that creates no version. `wrangler rollback` and `wrangler versions deploy` point a new deployment at an existing version, so nothing in the binding moves. Isolate boot time would flag it — and would also flag every cold start, and a false invalidation is worse than a missed one. A client that must know that case asks Cloudflare's deployments API.
