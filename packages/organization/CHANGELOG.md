# @pithy-sh/organization

## 0.2.0

### Minor Changes

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - An invitation email links to your app, not to this capability's JSON.
  
  `invitationAcceptUrl` built the link from `basePath` — the prefix every route here mounts under — and `GET {basePath}/invitations/:token` answers `c.json(...)`. So every invitation this capability has ever sent pointed a person at a response body in their browser. Not a page, not an actionable error: the offer rendered as JSON.
  
  No composition could avoid it. Aiming `basePath` at a page path does not help, because the JSON route mounts there too and the Worker answers before any client router sees the request.
  
  `invitationAcceptPath` is now a setting of its own, `/invitations` by default, and the mail is built from it. The page you serve at `/invitations/:token` reads `GET {base}/invitations/:token` for the offer and posts the token to `POST {base}/invitations/accept` to redeem it — both unchanged.
  
  **If you have already composed this capability**, check where your app serves that page. The default matches the conventional path; a project that mounted its acceptance screen elsewhere should set `invitationAcceptPath` to match, and pick it before inviting anybody, because changing it breaks the link in mail already sent.
  
  `INVITATION_ACCEPT_SEGMENT` is renamed to `INVITATIONS_ROUTE_SEGMENT`. It names the JSON routes' segment inside `basePath` and no longer has anything to do with the accept link, and a constant still called *accept* would point the next reader at exactly the conflation this fixes.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Tenancy, out of the box.
  
  Organizations, memberships, roles you define with the powers they hold, invitations bound to an address, ownership that moves only when somebody accepts it, and an acting selection proved against a live membership on every request. The model the Pithy dashboard itself runs on.
  
  **You declare the roles**, because a coaching academy's `coach` and `student` are parallel where a dashboard's `owner`, `admin` and `member` nest — and a capability that assumed either shape would refuse the other. Nesting is asserted only where you claim it. Five power names are the kit's, because it ships the routes that gate on them; yours sit beside them under your own vocabulary, and your handlers import them as typed values rather than reading strings out of a config file. `pithy add organization` scaffolds the catalog and never overwrites one.
  
  `administrativePower` is named rather than inferred from a role spelled `admin`, so an account with one owner and one admin does not become unadministrable when the admin leaves. Assignability is derived by exclusion, so a role you add is assignable by default and excluding it is the deliberate act.
  
  **What a membership is worth is what makes the refusals load-bearing.** A caller naming an organization they do not belong to gets a 404 byte-identical to the one for an organization that does not exist, because a distinguishable refusal is an existence oracle and iterating it produces your customer list. A role is decoded off the row and refused when the catalog does not know it, never asserted against a matrix that would deny everything today and allow it after one refactor. Nothing about a role rides on the session — only the id of the chosen organization — so removing a membership row is the whole of revocation and takes effect on the next request with no sign-out.
  
  The acting membership lands on its own context variable rather than on the auth one, because "signed in" and "a member of this organization" are two conditions and merging them makes them one. Composing this alongside Better Auth's `organization()` plugin is refused at boot, and `docs/why-not-better-auth-organization.md` is the record of why this model rather than that one — checked against `better-auth@1.7.1` line by line, including where the comparison has been stated wrongly before.
  
  `@pithy-sh/core` gains a manifest-level `seams` field, for a capability that needs a scaffolded module under every configuration rather than under one choice of one option.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Deleting an organization now deletes your rows too, if you say which.
  
  `deleteOrganization` swept its own five tables and stopped. Every adopter who composes this capability has tables keyed on `organizationId` — that is what tenancy is — and it cannot see them, so their rows stayed behind for an account that no longer existed. Where those rows hold a credential, the act everybody believes revoked it did not.
  
  `organization({ onDelete })` takes a function returning statements, and they join the same `d1.batch`, ahead of this capability's own. **Statements rather than work**, because that is what puts them in the transaction: a failure anywhere rolls all of it back, so the account and your rows end together or neither does. A callback that deleted for itself could not be in that batch, and what it leaves behind on a bad day is the bug.
  
  They run before the memberships go, so one may still resolve something through a membership.
  
  A composition without `onDelete` behaves exactly as before.

### Patch Changes

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - A session ending now takes the acting selection with it.
  
  `clearActing` existed, was exported, and **nothing called it** — so the acting selection outlived the credential that made it, one orphan row per sign-in, in a table with no TTL and no sweep. The capability's own schema says "signing out must take it with it"; there was no moment at which it could.
  
  Nothing in `@pithy-sh/organization` can see a sign-out, and the dependency runs the wrong way to fix that there. So `@pithy-sh/auth` grows an `onSessionRevoked` seam, and the project composing both joins them:
  
  ```ts
  auth({
    onSessionRevoked: async ({ id }, d1) => {
      await clearActing(organizationDatabase(d1), { sessionId: id });
    },
  }),
  ```
  
  **On the row, not on the sign-out route.** A sign-out, a revoke and an admin ending somebody's devices all delete the same row, so a listener hung off one endpoint would miss the others. It is handed this request's D1 binding because the auth instance is built per request, and it swallows what it throws — the session is already gone, and a listener's failure must not turn a completed sign-out into an error the caller retries.
  
  Composing `@pithy-sh/auth` without a listener is unchanged and requires nothing.
  
  The orphan row never conferred anything — every read re-joins memberships and matches the user id too — so this is growth rather than an access question.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Inviting an address that already holds an offer is one transaction, not two statements.
  
  `invite()` canceled the standing offer and inserted the new one in two separate awaits. Two concurrent invitations to one mailbox — a double-clicked Send, a retried POST — both found nothing to supersede and both inserted. The partial unique index underneath refused the second, so the table stayed correct, but the caller that lost got a raw constraint violation: a 500 on an ordinary action.
  
  Both statements now go into one `d1.batch`, which D1 runs as a transaction, the same way `acceptInvitation` already did and for the same reason. The later of two concurrent invites supersedes the earlier and both callers get the offer they asked for. The index stays underneath as the backstop for a writer that never came through here.
  
  Two migrations also now drop every index they create, matching the fourteen that already did — `@pithy-sh/organization` created six and dropped none, `@pithy-sh/secrets` created one and dropped none. SQLite takes an index with its table, so this changes nothing at runtime; what it changes is that a `down` reads as the inverse of its `up` in every capability, and a new test across the whole tree fails when one stops.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Three migrations said D1 does not enforce foreign keys. It does.
  
  `PRAGMA foreign_keys` is on, a cascade fires, and an orphan insert is refused with `FOREIGN KEY constraint failed` — measured against a real binding in two separately configured pools, and now pinned by a test in `@pithy-sh/core` that checks both directions.
  
  The convention those docblocks describe is unchanged and still right: no foreign key crosses a capability boundary, because a constraint from one capability's table to another's binds two release cadences together and breaks the day either moves to its own database. What changes is the reason given for it. A false reason is worse than none, because it ends the conversation — and it was ending it on the platform rather than on the boundary, which is where the real trade is.
  
  Nothing about any schema moves. Within a single capability's own tables a foreign key is available and is still not used; that is worth revisiting per table rather than as a rule.

- [#573](https://github.com/pithy-sh/pithy/pull/573) [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2) Thanks [@kingmesal](https://github.com/kingmesal)! - Volunteering for an ownerless account now takes standing over it.
  
  **Security: a member of any account that had never transferred ownership could make themselves its owner, in two requests, irreversibly.** `nominate()` allowed a self-nomination whenever nobody held the account and checked nothing else, and the route that reaches it carries membership and no power — deliberately, because the obvious `billing:manage` gate demands the owner the account does not yet have.
  
  The reachability is the part worth stating: `founderRole` gives a founder the first *assignable* administering role and the conferred role is unassignable by definition, so **every account is ownerless from the moment it is founded** and stays so until somebody completes a transfer. So "anybody in it may volunteer" meant any member of almost every account — and since a transferable role must administer, that self-transfer took a reader holding `organization:read` to `members:manage`, `billing:manage` and `organization:delete`. Nothing undid it: the conferred role is unassignable, so demote, remove and leave all refuse it.
  
  A volunteer must now already administer the account. That closes it without closing the account, because `founderRole` is defined as an administering role — a fresh account always has somebody who can take it on. The rule lives in `nominate()` rather than as route middleware, so an adopter calling the store directly gets it too.
  
  Three other defects found in the same pass:
  
  - `acceptNomination` dereferenced `withD1Retry`'s result without checking it. That wrapper returns `undefined` when a unique-constraint failure lands on a retry, so a transient fault could surface as a `TypeError` and a 500 rather than the refusal the code intends.
  - `acceptInvitation` reported an invitation as accepted while its row was still `pending`. `d1.batch` is a transaction, so the membership collision that reaches the fallback rolls the status update back with it — leaving a live redeemable token, an offer still listed as outstanding, and an audit row saying otherwise. The offer is now consumed on that path, which is what the module already documented.
  - `catalog.powersOf`, `roleAllows` and `administers` threw a `TypeError` for a role named `toString`, `constructor` or `valueOf` — the lookup reached `Object.prototype`, so `?? []` never fired. They deny now, which is what their own comment claimed. Unreachable from inside this package, which decodes every role through `Role` first, and reachable from an adopter's own handler, which is the advertised use.
  
  And in `@pithy-sh/auth`, `sanitizeProfile` let a `name` that was not a string through untouched, so a provider sending a number or an object at sign-up reached the column. It is replaced now, as an over-long one already was.
- Updated dependencies [[`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`afc4235`](https://github.com/pithy-sh/pithy/commit/afc4235968d9d6b31470a356da1a95936a6fe98c), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2), [`814bc25`](https://github.com/pithy-sh/pithy/commit/814bc25fb852dc6397c1824ca8cbd82f52f52be2)]:
  - @pithy-sh/core@0.6.0
  - @pithy-sh/auth@0.6.0
  - @pithy-sh/email@0.3.2
