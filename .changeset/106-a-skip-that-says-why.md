---
"@pithy-sh/cloudflare": patch
"@pithy-sh/cli": patch
---

A live suite that skips now says which fixture it wanted, and where to make it.

Some suites need a real thing a human makes once in a console — a Turnstile widget on a `workers.dev` hostname, a zone with Email Routing on it, an OAuth client. Until now each one gated itself on whatever `process.env` read its author happened to write, and a run with nothing configured printed "skipped" and nothing else. Two failures hide in that silence, and both have cost this repository time: a gate that throws on a missing fixture turns "you have no credentials" into "the kit is broken", and a run where everything skipped is indistinguishable from one where everything passed.

`LIVE_FIXTURES` in `@pithy-sh/cloudflare/src/test-utils/fixtures` is the estate, declared once. `fixtureReady("turnstile-widget")` is the boolean a `describe.skipIf` negates, and `docs/FIXTURES.md` is the document every skip line points at — with a test that fails if a fixture cites a section nobody wrote.

**Absent means skip, never fail.** A checkout with no credentials runs the whole suite green. The report is what makes the skip visible: it runs from `globalSetup`, once per run, before a single suite is collected, and **before the credentials are read** — a contributor with no account is exactly who needs telling why the run went quiet, and gating that explanation on the thing it explains is how it goes silent for them. It never throws, exactly as the debris sweep beside it does not.

**Three outcomes skip, and only one of them is fine.** `absent` is nobody having configured anything. `declined` is a switch deliberately off. `malformed` is somebody who tried and failed — an empty string from a CI job exporting an unset secret, whitespace, or the literal text `undefined` from a shell that interpolated nothing. Each is non-empty enough to pass a `Boolean(value)` check and reach Cloudflare, which answers 401 three frames later. None of them fails the run; all of them are named. That is #323's distinction one layer up: "not set" is a claim, and it is made only when nothing was set.

`PITHY_LIVE_DEPLOY` moves onto the helper and becomes a word rather than a non-empty string: `1`/`true`/`yes`/`on` arms the secrets deploy round trip, `0`/`false`/`no`/`off` declines it, anything else is malformed and skips. It deploys real Workers and deletes them again, so `0` had to mean no.

A value never appears in a line, in any outcome, and a test plants one and proves it.
