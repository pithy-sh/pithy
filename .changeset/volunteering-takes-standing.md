---
"@pithy-sh/organization": patch
"@pithy-sh/auth": patch
---

Volunteering for an ownerless account now takes standing over it.

**Security: a member of any account that had never transferred ownership could make themselves its owner, in two requests, irreversibly.** `nominate()` allowed a self-nomination whenever nobody held the account and checked nothing else, and the route that reaches it carries membership and no power — deliberately, because the obvious `billing:manage` gate demands the owner the account does not yet have.

The reachability is the part worth stating: `founderRole` gives a founder the first *assignable* administering role and the conferred role is unassignable by definition, so **every account is ownerless from the moment it is founded** and stays so until somebody completes a transfer. So "anybody in it may volunteer" meant any member of almost every account — and since a transferable role must administer, that self-transfer took a reader holding `organization:read` to `members:manage`, `billing:manage` and `organization:delete`. Nothing undid it: the conferred role is unassignable, so demote, remove and leave all refuse it.

A volunteer must now already administer the account. That closes it without closing the account, because `founderRole` is defined as an administering role — a fresh account always has somebody who can take it on. The rule lives in `nominate()` rather than as route middleware, so an adopter calling the store directly gets it too.

Three other defects found in the same pass:

- `acceptNomination` dereferenced `withD1Retry`'s result without checking it. That wrapper returns `undefined` when a unique-constraint failure lands on a retry, so a transient fault could surface as a `TypeError` and a 500 rather than the refusal the code intends.
- `acceptInvitation` reported an invitation as accepted while its row was still `pending`. `d1.batch` is a transaction, so the membership collision that reaches the fallback rolls the status update back with it — leaving a live redeemable token, an offer still listed as outstanding, and an audit row saying otherwise. The offer is now consumed on that path, which is what the module already documented.
- `catalog.powersOf`, `roleAllows` and `administers` threw a `TypeError` for a role named `toString`, `constructor` or `valueOf` — the lookup reached `Object.prototype`, so `?? []` never fired. They deny now, which is what their own comment claimed. Unreachable from inside this package, which decodes every role through `Role` first, and reachable from an adopter's own handler, which is the advertised use.

And in `@pithy-sh/auth`, `sanitizeProfile` let a `name` that was not a string through untouched, so a provider sending a number or an object at sign-up reached the column. It is replaced now, as an over-long one already was.
