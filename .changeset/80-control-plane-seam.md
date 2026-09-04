---
"@pithy-sh/core": minor
"@pithy-sh/payments": minor
"@pithy-sh/cli": minor
---

The `control-plane` seam: inbound, adopter-authenticated admin access to your own Worker, with no data plane in between.

`control-plane` has been a declared strategy with nothing behind it. Now it is real, and it ships present-and-denying: a Worker that composes it and has never been connected answers every control-plane route with 403, and there is no flag that changes that. `pithy dashboard connect --env production` is the deliberate second step; `pithy dashboard disconnect` is a row you delete, immediate and needing nothing from anybody else.

The credential is asymmetric. A management client holds an Ed25519 private key; you hold, rotate, and revoke the public one. Nothing secret of yours ever leaves your infrastructure, so a breach on their side is not a breach on yours — which a shared HMAC secret could never have offered. Each call carries a 60-second, single-scope token bound to a digest of its own body, checked against a replay set, and audited under its own actor kind, so what a management client did is answerable separately from what your users did.

Rotation is append, prove, then expire — never replace. A rotation that fails leaves the old key working rather than locking anyone out. Proof is by use: the call that retires a key must itself be signed with the successor, because naming a live key is not evidence you can sign with it. The Worker refuses an expiry that names a key other than the one that signed, and refuses one that would leave no live key at all. Lockout is the one failure mode with no recovery path, so it is rejected rather than trusted not to happen.

Revocation comes at two sizes. `pithy dashboard disconnect` removes the connection; `pithy dashboard revoke-key` pulls a single leaked key and leaves the rest standing. Both are writes to your own D1 and need nothing from the client — revocation that required the other side's cooperation would not be revocation.

A control-plane call creates no user and no session. A management client is not a user of your app, so it lands on `c.var.controlPlane` and never on `c.var.auth` — otherwise every `requireAuth()` in every capability would pass for it.

Capabilities contribute their own admin routes behind `requireControlPlane(scope)`, and those routes deny in a Worker that never composed the seam. `@pithy-sh/payments` is the first: manual entitlement grant and revoke now sit behind a real credential instead of the interim scope check they shipped with.

They also **describe** those routes. `GET /control-plane/manifest` reports every composed capability with its admin routes — full path, method, and required scope — so a management client composes its calls from the Worker rather than from a route table it ships with. That matters because `basePath` is configurable: an adopter who mounts payments at `/billing` gets a manifest naming `/billing/entitlements/grant`, where a client assuming the default would have 404'd. Each route's scope against the connection's grants is what lets a client gray out what it may not do instead of discovering a 403. A capability with no management surface reports an empty list, because "composed but nothing to administer" and "not installed" are different facts. The declarations are checked against the router that actually mounted, so a manifest cannot quietly drift into lying.

The minting side ships too. The seam is MIT and never gated by tier, so building your own management client against your own Worker is a real option, and `pithy dashboard connect --public-key` registers a key with no dashboard involved at all.
