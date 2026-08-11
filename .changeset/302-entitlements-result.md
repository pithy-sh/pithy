---
"@pithy-sh/payments": minor
"@pithy-sh/ui-react": minor
---

`getEntitlements` reports a failed read as a failure, not as an empty entitlement list.

It answered `[]` for an unreachable Worker, a proxy's HTML error page, a 500, and a body that failed its own type guard — the same answer it gives for a customer who genuinely holds nothing. It was the only reader in the client that discarded a `PaymentsResult`; `call` had already built the failure, with `PAYMENTS_UNREACHABLE` and `PAYMENTS_UNREADABLE` distinguished, before the last line threw it away.

Failing shut is right for a **lock** — a paywall that cannot reach the Worker must show the paywall, and the server's `requireEntitlement()` is the boundary either way. It is wrong for a caller that **names** the plan. Free is the floor of every ladder: it carries no entitlement key and matches unconditionally, so `[]` is a positive assertion that this customer is on the cheapest tier. A screen rendering that from a failed read tells an Enterprise customer they are on Free, and offers to sell them an upgrade to something they already pay for.

So `getEntitlements` returns `PaymentsResult<readonly EntitlementView[]>`, like every other reader in the file. Callers that want fail-shut keep it in one visible line — `result.ok ? result.value : []` — which reads as the decision it is rather than as the absence of one. `useEntitlement` and `useSubscription` gain a `readFailure`, distinct from both in-flight and empty, and the scaffolded subscription screen no longer renders "Nothing yet." over a read that never happened. A test holds the module to it, so a fifth producer fails the build rather than repeating this.

Found building `pithy-sh/dashboard`, whose rail names the visitor's plan beside the panes that plan unlocks.
