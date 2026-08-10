---
"@pithy-sh/core": patch
---

A control-plane response says which build answered **and what timestamp the platform reports for it**.

`workerVersion` read the `id` off `CF_VERSION_METADATA` and dropped the rest, and the module docstring described a binding with two fields. Measured against a real `wrangler dev`, it has three: `{ id, tag, timestamp }`, every value a string, `timestamp` an ISO-8601 instant. `workerVersionMetadata` now reads all of it; `workerVersion` is its `id` and keeps its shape, because four callers hold that shape and every one of them wants a single opaque string.

The seam stamps a second header, `pithy-worker-version-created`, beside the existing one. Two headers rather than a richer value in the first: a client already deployed compares that whole string, so folding a field into it would make a kit upgrade read as a version change that never happened.

**`workerBuildChanged` is the rule for reading the pair, and it ships beside the header names.** Compare field by field, only where both sides carried a value; anything that differs is a change. That is four states, and the third is the one #260 was filed for: the **same `id` with a timestamp that moved is the same build deployed again** — invisible to a client comparing ids, which is what the first adopter's cache invalidation does today. The rule lives in `controlPlane/wire.ts` because the dashboard did not only copy the header name, it wrote its own rule for the value and got it wrong; a rule both ends must agree on belongs beside the names both ends must spell.

**Absence stays silence**, in every direction — never seen, no longer sent, only just started, or blanked by something in between. A field the binding did not carry stamps no header, and a `timestamp` that is not a parseable instant is reported as absent rather than relayed. One gate states it: everything the seam says about the running build is a value the platform handed this Worker, byte for byte.

**Which moment that timestamp names is not settled, and nothing depends on knowing.** Cloudflare documents the binding's `timestamp` as the version's creation time; the first adopter's maintainer reports seeing it move on a rollback, which would make it the deployment's. Neither has been measured — it needs a real deploy and a real rollback against a real account, and `wrangler dev` cannot stand in because it mints a fresh version on every restart. So the value is compared and never interpreted, and the docs say so rather than picking a reading. Under one, the same-id state never occurs and the branch is dead; under the other it is the whole point.
