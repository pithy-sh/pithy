---
"@pithy-sh/core": minor
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/audit": minor
"@pithy-sh/auth": minor
"@pithy-sh/email": minor
"@pithy-sh/ledger": minor
---

Everything between the control-plane seam and a management client that can actually address a project and read something from it.

**A Worker's address is declared once.** `domains: { prod: { pattern, zone } }` in a Worker's own `pithy.config.ts`, per environment, and the `routes` entry with `custom_domain` and `vars.BASE_URL` are generated from it. Three commands used to reconstruct that address three different ways — `pithy env` scraped the first route, `email provision` and `turnstile` read a hand-set `BASE_URL`, and `deploy` scraped whatever URL wrangler last printed — and nothing noticed when they disagreed. One resolver replaces all three, preferring the declaration, falling back to a route and then to the var, so a project that predates this keeps working and is never told to migrate. `pithy init` and `pithy worker add` ask for it against the account's **real Cloudflare zones**, so a typo fails at `init` with a list of what exists rather than at `deploy` with a Cloudflare error to decode; the prompt is skippable, and it degrades to free text when the account is unreachable.

**`pithy deploy` proves the Worker it shipped is the one answering.** `GET /health` now reports the running build, and deploy probes the *declared* domain and asserts the version matches what it just shipped. A liveness check would not catch the failure worth catching — the old version answering happily at the declared domain while the deploy landed somewhere else. It retries through propagation, and reports a gradual rollout as inconclusive rather than failed.

**`CF_VERSION_METADATA` is finally bound.** The logger has always read it and `docs/LOGGING.md` has always documented it, but no template declared the binding, so the `version` field was absent in every scaffolded project and nobody could correlate a log line to the deploy that produced it. Both scaffolds now emit it, `pithy upgrade` adds it to an existing project, and a parity test holds the two generators together — two unsynchronised producers is *how* it went missing. The id reaches five consumers: every log record, every audit event, the control-plane manifest, a `pithy-worker-version` header on every control-plane response, and the deploy check.

**The manifest reports both version axes.** The Cloudflare build id says *which build* — the answer for forensics. The composed `@pithy-sh/*` versions, per capability and never aggregated, say *which features* — the answer for "should this customer upgrade" and "who is exposed to what we just fixed". A Worker cannot read its own `package.json`, so each package's version is stamped into a committed constant with a CI check against drift.

**Registration is self-sufficient.** `pithy dashboard connect` resolves the Worker URL itself instead of demanding `--worker-url`, names its Worker and refuses ambiguity in a multi-Worker project, and sends the seam's `basePath` — the one address a client cannot discover, because it *is* the manifest's address. Without it an adopter who mounted the seam at `/admin` registered cleanly, passed the ping at the assumed path, and then 404'd on every call.

**Admin routes on the capabilities that shipped before the seam.** `@pithy-sh/auth` (find and read users with sessions and devices; revoke a session, sign a user out everywhere, revoke a device — no impersonation), `@pithy-sh/audit` (page the trail, read one event in full), `@pithy-sh/email` (jobs by status and in detail, retry, the suppression list), `@pithy-sh/ledger` (balances and history, read-only). Least-privilege scope per operation, audited including reads, keyset pagination on every list through one shared core helper, and each declaration drift-tested against the router that actually mounted.

**The replay guard holds.** A control-plane token is now spendable exactly once, claimed with `INSERT … ON CONFLICT DO NOTHING` on the `jti` primary key — strongly consistent, wherever the requests land. The KV guard it replaces had no compare-and-set and was eventually consistent across colocations, so a replay arriving at a different colo inside the propagation window passed. Narrow is not harmless: a nudge sends real people a second email. KV stays selectable behind the same interface with the race stated; the D1 default needs no KV namespace at all.
