---
"@pithy-sh/payments": major
"@pithy-sh/core": minor
"@pithy-sh/support": patch
---

An entitlement is held by a subject, and a subject is not always a user.

`pithy_payments_entitlements` was `UNIQUE (userId, entitlement)`, and every read of it asked who a person is. That is right for a consumer app and wrong for every business that sells to companies: the organization signs, the organization is invoiced, and everybody in it holds what it bought. Modelling that on a user-keyed table meant granting to every member — a fan-out that drifts the moment somebody joins — or granting to the owner, which makes the plan theirs and shows an invited colleague `Free` while their employer pays for Team.

So the holder is a pair. `subjectType` is a closed enum, `user` or `organization`; `subjectId` is its id. Both halves travel together in every row, every comparison and every provider reference, because nothing in the kit keeps an organization id from equalling some user's id — a check that read one half would let one hold the other's subscription. `pithy_payments_purchases` and `pithy_payments_provider_accounts` move with the entitlements table, so a webhook resolving to an organization writes an organization everywhere and never half of one.

**`billingSubject` is required, with no default.** One answer per project: a codebase that could grant to a person on one route and a company on the next is one where the two eventually disagree about who is entitled, and the disagreement arrives as somebody refused something they paid for. It is not defaulted because it decides what a stored row means, and a project that meant `organization` and never saw the question finds out when it has subscriptions. `pithy add payments` asks; a `--json` run that does not say is refused, naming the flag.

**The capability never learns what an organization is.** It has no members table and no business acquiring one. Under organization billing it asks the adopter *which subject is this caller acting for*, through a `resolveSubject` function on `payments()`, and the adopter answers from its own session. Unanswered is unentitled — a read holds nothing and a write raises `payments/subject_unresolved`. There is no fallback to the authenticated user anywhere.

The spelling is `organization`, with a z. It is the stored token in a column and a UNIQUE index, and it has to match Better Auth's `organization()` plugin — the only realistic way an adopter has organizations at all — whose `activeOrganizationId` is what a resolver reads on the line above.

A denial now says *who* it was for. `payments resolved []` used to be the whole sentence, and it meant two different things — a company that has bought nothing, and a caller acting for no company at all, which is the ordinary state of somebody signed in with no organization selected. Those want opposite fixes. The resolver seam gained an optional `holder()` reporting a display label and a tenant, and the denial's audit row now carries that tenant, so a trail answers "which of our customers is hitting the paywall" — `actorId` never could, because one person acts in two organizations. It is deliberately not the holder itself: a label is prose and a tenant is an audit dimension, so there is nothing there for a gate to compare a caller against, and a test pins that the gate's decision is identical for every holder including none.

Three consequences worth stating rather than discovering. `resolveSubject` is a function, so it cannot cross the `JSON.stringify` into `PAYMENTS_CONFIG`: the reconcile and Paddle sweep Workflows always run with no resolver, and read every subject off a stored row. `@pithy-sh/ledger` is a per-user model, so a catalog that credits a balance is refused at composition under organization billing rather than at the purchase: an account is `(userId, currency)` and every route the ledger serves reads a user id, so a company's credit has nowhere to land that anything would read. A user's ledger account stays exactly what it was, their user id. And `@pithy-sh/support` resolves a person from an email address with no request to ask the seam, so its billing panel covers individually-billed purchases only and now says so on the wire instead of returning an empty list.

The migration is amended in place rather than chained, and it carries nothing across: nothing is published and no database holds a payments row. `pithy payments reconcile --user <id>` becomes `--subject user:<id>` — an id on its own is refused, because it names whichever holder happens to carry it.
