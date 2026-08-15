---
"@pithy-sh/auth": patch
"@pithy-sh/cloudflare": patch
---

Live E2E for the sign-in surface: the Google provider on localhost, and the Turnstile gate against real siteverify.

Two live suites, gated on the `google-oauth` and `turnstile-widget` fixtures separately, so neither takes
the other offline. Both boot the real auth Worker on a real port — Miniflare supplies D1 from Node,
`node:http` supplies the port — and reach the network only for the third party each one names.

Nothing completes a Google round trip. The suite asserts what only real Google can answer: the
`redirect_uri` the app hands the browser, composed from the port this run got and the base path it
pinned, and whether Google recognises the credential at all. Then the trust boundary — a forged `state`,
a spent one, a `code` that is not one, a provider answering garbage — and that social sign-in is never
behind the humanity gate, in an app whose gate demonstrably bites.

The Turnstile half is mostly refusal, because a gate watched only passing proves nothing. It runs one set
of assertions twice: against a real widget's secret when the fixture is there, and against Cloudflare's
documented test secrets when it is not. Cloudflare's own `result_with_testing_key` flag is what tells
them apart, so a fixture filled in with a test key fails loudly instead of certifying a gate that never
ran.

Also adds `fixtureReportSetup`, the `globalSetup` for an integration config whose suites create nothing:
the fixture report without the account-wide debris sweep.
