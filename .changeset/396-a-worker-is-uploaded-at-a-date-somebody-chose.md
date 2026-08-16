---
"@pithy-sh/cloudflare": patch
"@pithy-sh/cli": patch
---

A Worker created through the API runs on a compatibility date its caller chose. **`createWorker` requires one.**

`CloudflareWorkersManager.createWorker` supplied `2026-04-07` when the caller named none. It was not broken — that date is past #385's fix — but it sat below the `2026-06-01` floor `compatibility.ts` holds every other Worker in this repository to, and it was the one date #388's gate could not reach: the gate reads `wrangler.jsonc` manifests, and this was a TypeScript constant. #388 named the hole in its own docstring rather than move a number in passing.

**Moving it to the floor was the obvious answer and it is the wrong one.** A compatibility date is a behaviour contract, not a version number — it is the date workerd pretends it is — and this one lands on Workers in accounts that are not ours. Re-picking the number changes what an existing caller's Workers run, silently, for somebody who never asked. And the new number goes stale on exactly the schedule the old one did, with the same gate still unable to see it. `compatibility.ts` makes that argument about `2026-03-03` already: *the minimum that fixes the last bug is exactly the number `2025-01-01` once was.*

Requiring the date removes the class instead of re-picking the number, which is the move #377, #366 and #394 each took. It is also the cheaper break: a caller who wanted `2026-04-07` writes `2026-04-07` and gets precisely what they had, and everybody else finds out at compile time rather than from a behaviour change in production. `WorkersProvisioner` already promised this one level up — *"it carries no environment- or product-specific defaults"* — and the manager under it was the one place that was untrue.

`metadata` may no longer also carry `compatibility_date`, and a date that is not an ISO date is refused here rather than by a 400 from Cloudflare. Two ways to state one contract is a precedence rule to remember, which is what this change exists to delete.

**#388's gate has no exception left.** Its docstring said so and now says why it does not.

The reasoning is at the site, on `createWorker`, not only in the issue.
