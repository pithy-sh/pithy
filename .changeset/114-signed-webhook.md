---
"@pithy-sh/core": minor
"@pithy-sh/payments": patch
---

Give `signed-webhook` an implementation any sender can be verified with.

`signed-webhook` has been a first-class verification strategy since the contract landed, but the only code behind it was the payments webhook guard — welded to a rail catalog, a D1 table and a dedup insert. An adopter declaring the strategy on their own route had the word and nothing to put behind it.

`requireSignedWebhook` from `@pithy-sh/core/src/http/signedWebhook` is that implementation: `<header>: t=…,v1=…`, one hex HMAC-SHA256 per signature over `<timestamp>.<body>`. Stripe's format, because it is the one every other sender copied. The timestamp is inside the signed payload, so re-dating a captured delivery invalidates its own signature; the freshness window is checked in both directions; the comparison is `crypto.subtle.verify`, never `===`; every listed signature is tried, up to a cap, so a rotation on either side keeps verifying without buying an anonymous caller unbounded HMAC work. A refusal is `core/webhook_unverified` (401) with the failing step in `detail`, which the HTTP codec strips.

Dedup stays the caller's. This proves a delivery is authentic and fresh, never that it is new — a handler that grants or charges needs its own uniqueness key.

Payments' Stripe rail now composes the primitive through `checkSignedWebhook`, which reports rather than throws, and keeps `payments/verification_failed` and its own wording. The verifier no longer exists twice.
