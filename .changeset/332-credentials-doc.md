---
"@pithy-sh/payments": patch
"@pithy-sh/turnstile": patch
---

Send the credentials link somewhere that names a console.

`payments-provider-credentials` declared `documentation` as one page for five rails, and the page named no console for any of them. The field exists to end a search. That link cost the click and returned the reader to where they started.

`PAYMENTS_RAIL_CONSOLES` now holds the deep link to each rail's settings screen — App Store Connect's Integrations page, Google Cloud's service accounts, Stripe's API keys, Lemon Squeezy's and Paddle's authentication settings. Five issuers, five hosts. `docs/commands/payments.md` carries them as a table, `documentation` points at that table by name, and `registry.test.ts` reads the file off disk and fails when a rail's console is not in it. The refusal an unprovisioned rail throws names that rail's console in `action`, where no link has to be rendered at all.

`documentation` is one required URL and this secret has five issuers, so one string can be true of at most one rail. The entry points at ours because no company documents a competitor's console. That is a hop the field does not promise; the shape that would remove it is `SecretOrigin`'s, and it is argued in #332.

Turnstile's origin link moves from `turnstile/get-started/` to the widget-management dashboard page. The first is a hub offering three implementation methods and naming no console; the second carries the dashboard URL and says to copy the sitekey and secret key. Auth's four, media's two, storage's and secrets' were opened and reach a console or the API call that replaces one.

Fixes #332
