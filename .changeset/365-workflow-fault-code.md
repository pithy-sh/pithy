---
"@pithy-sh/core": patch
"@pithy-sh/cloudflare": patch
---

Report a terminal Workflow failure under the raising error's own code and status, not the transport's.

#349 got the step's sentence to the CLI and #353 got its remedy. The `code` and the `status` were still `dispatchAndPoll`'s: it threw `CloudflareRequestError`, which fixes `cloudflare/request_failed` and 502 by construction, so `pithy secrets create` on a name that already exists answered with a 502 for a fault the step raised as `secrets/already_exists` with 409. **502 says the far side is broken and to try later; 409 says the thing exists and to do something else.** Anything branching on the pair — a retry loop, a CI step, an operator deciding whether to page — was told the opposite of what happened, and `cloudflare/request_failed` sent the reader at Cloudflare for a fault Cloudflare had nothing to do with.

Four outcomes now, and a caller tells them apart on `code` alone:

| What happened | Code | Status |
|---|---|---|
| A step raised, and the kit pins a status for its code | that code | that status |
| The run ended terminally, nothing attributable | `core/workflow_failed` | 500 |
| The dispatch or a poll could not be delivered | `cloudflare/request_failed` | 502 |
| This client stopped waiting; the instance may still finish | `core/upstream_timeout` | 504 |

The first two are terminal. The last two are not, and only they may be retried.

**No fourth field crosses the durable boundary.** Nothing but `code`, `message` and `action` survives a step — the engine records the throw's text and discards the throw — and reopening the format #353 froze against a measurement buys nothing here: every kit member pins `status` to one literal, so the code *is* the status. `kitErrorStatus` reads it off the union. A code the kit does not define has no pinned status, and rather than invent one the boundary says so with `core/workflow_failed` and keeps the step's own sentence.

`core/workflow_failed` is a 500, deliberately not a 502: the durable job is the kit's own code in the operator's Worker, and its step journal — which `detail` names — is where the answer is.

`detail` still does not cross. The only fields promoted from the far side are `message` and `action`, both already public and both already proved kit-authored.

The gate is in `stepFailure.test.ts`: every captured instance states its expected code and status as hand-written literals, and the set of codes a terminal fault can arrive under is asserted disjoint from the transport's. Planted against five ways — restoring the old boundary turns 18 tests red across both packages.
