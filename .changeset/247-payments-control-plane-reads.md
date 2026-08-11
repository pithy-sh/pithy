---
"@pithy-sh/payments": minor
---

Payments declared no control-plane read, so purchases and entitlements were unreachable.

Its entire management surface was `POST entitlements/grant` and `POST entitlements/revoke` — a console that could comp an entitlement and take one back, and could never list one. The purchase log was reachable only through `requireAuth()` routes, which a management credential can never satisfy: the seam leaves `c.var.auth` null by design. Measured in the first adopter against a live manifest, its Purchases, Entitlements and Subscriptions panes all computed `access=absent` and dropped out of the rail. Not blocked, not refused. **Absent** — which no grant restores and no seed repairs, because there was no route to grant a scope to.

Four reads, three scopes, under `admin/` because the buyer-facing surface already owns `/payments/purchases` and `/payments/entitlements`:

- `GET {base}/admin/purchases` — `payments:purchases:read`. Paged, newest first, filtered by account, store, status or store environment.
- `GET {base}/admin/subscriptions` — `payments:subscriptions:read`. The same rows narrowed to the ones that renew, so a renewal tool can be granted the forward-looking half without a customer's whole order history.
- `GET {base}/admin/entitlements` — `payments:entitlements:read`. What accounts hold, whether it grants right now, whether a human wrote it, and which purchase is the reason.
- `GET {base}/admin/entitlements/:userId` — the same, for one account, unpaginated.

The shape is `@pithy-sh/ledger`'s, deliberately: keyset pagination through core's cursor helper, a Zod object per response in `http/responses.ts`, projections in `http/view.ts`, the read model in `admin/read.ts` beside the primitive rather than inside it, and every read audited — a credential quietly paging every account's commerce otherwise leaves no trace anywhere.

**The stored provider payload is not projected, and it is not selected.** It is the one column payments owns that is a bearer artifact, and on Stripe a document carrying the buyer's email address, name and billing details. Every management query names its columns and that one is not among them, so a receipt never reaches the Worker's memory on a read. That is this capability's answer to the question `@pithy-sh/email` answers by masking a recipient: payments stores no direct personal identifier of its own — the only identity column is the opaque `userId` a management client must already name — so the field that would have carried an address is refused outright rather than masked.

`payments_0001_purchases` carries the three indexes these were written for. The purchases primary key is a text UUID, so it is unique but not monotonic and is no use as a sort; without the indexes every page of a purchases pane would sort a customer's entire order history to return twenty-five rows. `down` drops all three and is tested, as is the query plan.

The gate is `admin/coverage.ts` and it states the invariant rather than listing routes: **every table payments stores decides, where it is defined, whether a management client may read it — and every resource the control-plane surface can write, it can also read.** The decision is typed as a total map over the table set, so a fifth table does not compile until somebody makes it; the test checks a table declaring a scope has a `GET` demanding exactly that scope, and that no write is left without a read. Payments was the only capability in the kit with that gap.
