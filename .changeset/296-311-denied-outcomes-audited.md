---
"@pithy-sh/payments": patch
---

A webhook that fails its authenticity check, and a grant refused for an unknown key, each leave an audit row.

Both were declared auditable and audited by nothing. `PaymentsAuditActions.webhookUnverified` existed with no producer, so the audited outcome of a webhook was *received* or nothing at all; and `POST /payments/entitlements/grant` refused a key outside the catalogue and recorded silence.

**Both are asymmetric in the wrong direction.** The successful webhook is recorded twice over — `webhook_received`, then the projection events — and the rejected one, which is the single payments event that is about an attacker rather than about a customer, was recorded zero times. The successful grant is recorded, and the refusal, which is the one that describes a caller behaving oddly, was not. One rejection is noise. A run of them against one endpoint is somebody probing a payment rail, or a credential scoped only to grant enumerating the entitlement vocabulary one key at a time — and that pattern is exactly what a trail is read for.

Both emit through `safeEmit`, because by the time either runs the 401 or the 400 is already decided. An audit write that threw would hand the caller a different response for a failing store than for a healthy one, which is both an availability bug and a signal it should not have. A failing store is asserted in both tests.

**Neither row carries anything the caller supplied verbatim.** The webhook row names the rail and the failing step, taken from our own error *code* rather than from a message a sender could influence. The grant row names the route and the submitted key — safe because `EntitlementKey` bounded it before the handler ran, and the only field that makes a run of refusals legible — and never the defined set, which is a separate disclosure behind `payments:catalog:read`.

On whether one gate could state *every denied control-plane write is audited* rather than fixing two known sites: not from where the repo stands. `auditActions.test.ts` catches a declared code with no producer, which is how the webhook case was found; what neither it nor any static check can see is a refusal path that throws without emitting, because that is a property of control flow rather than of a symbol. Naming it would need either a lint rule over throw sites in `src/http/**` or a convention that refusals leave through one helper. Worth its own issue; it is not a line this change could have added.
