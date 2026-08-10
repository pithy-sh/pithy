---
"@pithy-sh/core": patch
---

A control-plane response says which build answered **and when that build was uploaded**.

`workerVersion` read the `id` off `CF_VERSION_METADATA` and dropped the rest, and the module docstring described a binding with two fields. Measured against a real `wrangler dev`, it has three: `{ id, tag, timestamp }`, every value a string, `timestamp` an ISO-8601 instant. `workerVersionMetadata` now reads all of it; `workerVersion` is its `id` and keeps its shape, because four callers hold that shape and every one of them wants a single opaque string.

The seam stamps a second header, `pithy-worker-version-created`, beside the existing one. Two headers rather than a richer value in the first: a client already deployed compares that whole string, so folding a field into it would make a kit upgrade read as a version change that never happened.

**`workerBuildChanged` is the rule for reading the pair, and it ships beside the header names.** Compare field by field, only where both sides carried a value; anything that differs is a change. The rule lives in `controlPlane/wire.ts` because the dashboard did not only copy the header name, it wrote its own rule for the value — "invalidate when the id differs" — and a copied constant could never have caught that.

**Absence stays silence**, in every direction — never seen, no longer sent, only just started, or blanked by something in between. A field the binding did not carry stamps no header, and a `timestamp` that is not a parseable instant is reported as absent rather than relayed. One gate states it: everything the seam says about the running build is a value the platform handed this Worker, byte for byte.

**Versions and deployments are two objects, and this binding describes one of them.** A version is an immutable upload — id, created timestamp, tag, fixed at upload. A deployment points at one or more versions with traffic percentages, and is its own object with its own id and time. `CF_VERSION_METADATA` reports the version, and the runtime hands a Worker no binding for the deployment. So a rollback, which creates a new deployment aimed at an existing version, moves neither header — as does a traffic split or a gradual rollout. **Nothing inside a Worker can observe a deployment**; a client that needs one reads Cloudflare's deployments API. Measured on a real account on 2026-08-10 rather than inferred: two deploys, a real `wrangler rollback`, and the rolled-back-to version still reporting its original timestamp two minutes later.

The comparison stays total anyway. The same-id-moved-timestamp branch is unreachable on today's platform and costs one line, and a rule that enumerates which fields are allowed to move is wrong the day the platform moves a different one — wrong silently, as "nothing changed".
