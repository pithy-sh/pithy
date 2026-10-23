# @pithy-sh/organization

Tenancy in your own D1. Organizations, the people in them, the roles you declare and the powers those roles hold, invitations bound to an address, ownership that moves only when somebody accepts it, and a record of which account each session is acting in.

Every multi-tenant project on this kit writes this model, and the best implementation of it was sitting outside the kit — in `pithy-sh/dashboard`, which looked at Better Auth's `organization()` plugin and did not use it. This is that model, generalized. Its three fixed roles became a catalog you declare, because a coaching academy's `coach` and `student` are parallel where a dashboard's `member`, `admin` and `owner` nest, and a capability that assumed either shape refuses the other outright.

```sh
pithy add organization
```

**Documentation: [pithy.sh/docs/capabilities/organization](https://pithy.sh/docs/capabilities/organization).** Overview, adding it, using it, and the reference: roles and powers, the acting selection, invitations, ownership transfer.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

Four pages ship in the package as well, because each has to be readable from the code rather than only from a website: [`docs/organization-lifecycle.md`](docs/organization-lifecycle.md), what suspending, deleting, restoring and purging an organization does, and what it means for a member of several; [`docs/roles.md`](docs/roles.md), where roles are defined, how two unrelated role sets coexist, and which parts of a catalog can still be changed after somebody has joined; [`docs/scoping-your-own-tables.md`](docs/scoping-your-own-tables.md), the pattern that keeps *your* tenanted tables scoped — which this capability cannot do for you, because it has no view of them; and [`docs/why-not-better-auth-organization.md`](docs/why-not-better-auth-organization.md), the record of why this model rather than Better Auth's plugin.

## The seam

Three gates, composed on the route line. Nothing is implicit: a route that did not mount `requireOrganization()` has no organization, and a route that did has one that was proved on this request.

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { requireAuth } from "@pithy-sh/auth/src/http/middleware";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import { requireOrganization, requirePower } from "@pithy-sh/organization/src/http/guard";
import { organizationDatabase } from "@pithy-sh/organization/src/data/tables";
import { roles } from "./organization/roles";

const deps = {
  catalog: roles,
  database: (env: Record<string, unknown>) => organizationDatabase(env.DB as D1Database),
};

app.get(
  "/coaches",
  describeRoute({ summary: "List the coaches.", verification: ["bearer", "session"], responses: { 200: CoachList } }),
  requireAuth(),
  requireOrganization(deps),            // fills c.var.acting, or 404s
  requirePower("sessions:read", deps),  // asks the matrix, or 403s
  validate("query", ListCoaches),
  handler,
);
```

`c.var.acting` is the resolved membership. It exists only downstream of `requireOrganization()`, and it is non-optional there, so a handler reads the organization, the person and their role without a null check:

```ts
{ organizationId, slug, name, userId, role, chosen }
```

`role` narrows to the union your catalog declared. `chosen` says whether somebody picked this account or arrived at it because it is the only one they have — which is what a chooser keys on, and what nothing authorizes on.

Five properties hold this together, and each of them is a decision rather than an implementation detail.

**`acting` is a second context variable, not a field on `auth`.** `auth` says who is signed in, and the auth capability fills it for every request carrying a credential. `acting` says what they are entitled to **here**, and exists only where a gate has proved it. Merging them would make "signed in" and "a member of this organization" one condition, and the whole point is that they are two.

**A role is decoded, never asserted.** The column is text, because the catalog is yours and is not known when the schema compiles. A repair script, a rolled-back deploy or a bug can put anything in it, and a role matching no entry in the matrix would deny everything today and, one refactor later, allow it. It is parsed through the catalog on every read, so an unrecognized value refuses while there is still a request to refuse.

**A caller naming an organization they are not in gets the 404 for one that does not exist, byte for byte.** A distinguishable refusal is an existence oracle, and iterating it produces the tenant list. The distinction is real and rides in `detail`, which the HTTP codec strips and the log keeps.

**The selection is a preference; the membership is the authority.** Nothing about a role is cached and nothing rides on the session but the id of the choice, so deleting a membership row is the whole of revocation — it takes effect on the next request, with no sign-out and no cache to expire. A selection whose membership is gone is treated as no selection, not as a refusal: the person may still belong elsewhere.

**One predicate, both halves.** The user and the organization are matched in the same `where`, so there is no shape of the code in which a caller passes the membership check for one organization and acts on another. The two obvious bugs — a filter on the selection that forgets the user, a filter on the user that forgets the selection — both produce a real row attached to the wrong organization.

## Where roles are defined

In a module of your project, `src/organization/roles.ts`, scaffolded by `pithy add organization` and never overwritten once it exists. A module rather than a config literal, because your own route code imports the typed powers and importing from `pithy.config.ts` into a handler is backwards.

`defineRoles` closes the kit's seven power names — tenancy's five, and `media:manage` and `storage:manage` — opens yours under your own names, and carries the literals through: `c.var.acting.role` narrows to the roles as written, and `requirePower` refuses a power nobody declared at compile time rather than denying everyone at runtime.

### A catalog that nests

The dashboard's own, and its seven powers decompose with nothing left over — tenancy's five, plus two that exist because that particular product calls customers' Workers.

```ts
import { defineRoles } from "@pithy-sh/organization/src/roles/roles";

export const roles = defineRoles({
  powers: ["connections:read", "connections:manage"],
  roles: {
    member: ["organization:read", "connections:read"],
    admin: ["organization:read", "connections:read", "connections:manage", "organization:manage"],
    owner: [
      "organization:read",
      "connections:read",
      "connections:manage",
      "organization:manage",
      "members:manage",
      "billing:manage",
      "organization:delete",
    ],
  },
  administrativePower: "organization:manage",
  nests: ["member", "admin", "owner"],
  unassignable: ["owner"],
});
```

`nests` is asserted, not documented: every power `member` holds `admin` must hold, and every power `admin` holds `owner` must hold, or the catalog is refused at boot naming both roles. That is what makes a promotion and a demotion mean something a person can predict.

`unassignable: ["owner"]` is why a new organization here has no owner. Ownership is who pays the bill and signs, so it is accepted rather than conferred — inside the account it moves only by a two-party transfer, and otherwise only by an operator through the control plane ([Membership administration](#membership-administration)) — and the founder of an account gets the first role that administers and *may be assigned*, which is `admin`. Such an account works: it can be administered, invited into, read and renamed. It cannot be billed, which is the model saying out loud that nobody has yet agreed to pay for it.

### A catalog that does not

A coaching academy. `coach` and `student` are parallel, and each holds what the other does not.

```ts
export const roles = defineRoles({
  powers: ["sessions:read", "sessions:accept", "sessions:request", "students:block", "coaches:block"],
  roles: {
    owner: [
      "organization:read",
      "organization:manage",
      "organization:delete",
      "members:manage",
      "billing:manage",
      "sessions:read",
    ],
    admin: ["organization:read", "organization:manage", "members:manage", "sessions:read"],
    coach: ["organization:read", "sessions:read", "sessions:accept", "students:block"],
    student: ["organization:read", "sessions:request", "coaches:block"],
  },
  administrativePower: "organization:manage",
});
```

No `nests`, because these four are not a chain: `coach` and `student` are siblings and neither is above the other. `nests` takes the roles that do form one — `["admin", "owner"]` would be a true claim here, and claiming it would be worth doing — but it never describes the whole set by assumption.

No `unassignable`, so every role including `owner` may be handed to somebody, and the founder of an academy is its owner. Nothing about this catalog is a degraded case of the first one: it is a different shape, and the only thing the two share is tenancy's five.

## Routes

`{base}` is the configured `basePath`, `/organizations` by default. Everything under it answers JSON.

## Clear the acting selection when a session ends

The acting selection is keyed by session id, so it has to go when the session does. Nothing here can see a sign-out — tenancy depends on auth, not the reverse — so the project that composes both wires it:

```ts
auth({
  // Fires on a sign-out, a revoke, an admin ending somebody's devices: anything that deletes the row.
  onSessionRevoked: async ({ id }, d1) => {
    await clearActing(organizationDatabase(d1), { sessionId: id });
  },
}),
```

Without it the row outlives the credential that made it, one per sign-in, in a table with no TTL and no sweep. It confers nothing — every read re-joins memberships and matches the user id too — so this is growth rather than an access question, and it is still the kind of growth nobody notices until it is large.

## The one page you have to serve

**An invitation email links to your app, not to this capability.** `invitationAcceptPath` says where — `/invitations` by default — and the token arrives as the last segment, so the page you serve is `/invitations/:token`.

That page reads `GET {base}/invitations/:token` to show the offer, and posts the token to `POST {base}/invitations/accept` to redeem it. Both are in the table below.

They are two settings because they are two things: one is where this capability's API lives, the other is where a person is sent. Building the link from `basePath` is what `pithy-sh/pithy#571` was — every invitation pointed at the JSON route, so the recipient got a response body in their browser. Change `invitationAcceptPath` after an invitation has been sent and the link in that mail breaks, so pick it first.

| Route | Purpose | Verification | Power |
| --- | --- | --- | --- |
| `GET {base}` | The organizations the caller may act in | session | — |
| `POST {base}` | Found an organization, with the caller as its first member | session | — |
| `POST {base}/acting` | Choose which organization this session acts in | session | — |
| `GET {base}/current` | The organization in force | session | `organization:read` |
| `PATCH {base}/current` | Rename it, or set its mark | session | `organization:manage` |
| `DELETE {base}/current` | End it, and everything belonging to it | session | `organization:delete` |
| `GET {base}/current/members` | The roster, resolved through auth's published reader | session | `organization:read` |
| `PATCH {base}/current/members/:membershipId` | Change somebody's role | session | `organization:manage` |
| `DELETE {base}/current/members/:membershipId` | Remove somebody | session | `organization:manage` |
| `POST {base}/current/members/leave` | Leave, which is not the same act as being removed | session | — |
| `GET {base}/current/invitations` | The offers outstanding | session | `organization:manage` |
| `POST {base}/current/invitations` | Invite an address, at a role | session | `organization:manage` |
| `DELETE {base}/current/invitations/:invitationId` | Withdraw an offer | session | `organization:manage` |
| `POST {base}/current/invitations/:invitationId/resend` | Send an offer again with a new link; the old one stops working | session | `organization:manage`, and `members:manage` when the offered role administers |
| `GET {base}/invitations/:token` | What an invitation is offering, for the accept screen | public | — |
| `POST {base}/invitations/accept` | Accept one, as the address it names | session | — |
| `GET {base}/current/ownership` | Read the standing offer of ownership, if there is one | session | — (membership) |
| `POST {base}/current/ownership` | Offer ownership to a member | session | holding the account, or — where nobody does — volunteering yourself, if you administer it |
| `DELETE {base}/current/ownership` | Withdraw the standing offer | session | holding the account, or the offer being your own |
| `POST {base}/ownership/accept` | Accept ownership, and become the one who pays | session | — |
| `GET {base}/marks/organization/:organizationId` | An organization's stored mark, cacheable | session | — (membership) |
| `GET {base}/members/:membershipId/image` | A member's stored image | session | `organization:read` |
| `GET {base}/admin/organizations` | Every tenant, with how many people are in each | control-plane | `organization:accounts:read` |
| `GET {base}/admin/organizations/:organizationId/members` | One tenant's roster, with addresses | control-plane | `organization:members:read` |
| `PATCH {base}/admin/organizations/:organizationId` | Rename a tenant, give it a free short name, set its seat limit | control-plane | `organization:accounts:write` |
| `POST {base}/admin/organizations/:organizationId/members` | Add an existing user at a named role | control-plane | `organization:members:write` |
| `PATCH {base}/admin/organizations/:organizationId/members/:membershipId` | Change a member's role, to any role the catalog declares but the owning one | control-plane | `organization:members:write` |
| `DELETE {base}/admin/organizations/:organizationId/members/:membershipId` | Remove a member, and clear their selection | control-plane | `organization:members:write` |
| `GET {base}/admin/organizations/:organizationId/invitations` | A tenant's outstanding invitations, to fix one | control-plane | `organization:members:write` |
| `POST {base}/admin/organizations/:organizationId/invitations/:invitationId/resend` | Send one again with a fresh link, expired or not | control-plane | `organization:members:write` |
| `DELETE {base}/admin/organizations/:organizationId/invitations/:invitationId` | Revoke one, so its link stops working | control-plane | `organization:members:write` |
| `POST {base}/admin/organizations/:organizationId/ownership` | Make a member the owner now, with no nomination and no acceptance | control-plane | `organization:ownership:transfer` |
| `POST {base}/admin/organizations/:organizationId/suspend` | Suspend a tenant: nobody can act in it until it is reinstated or its end passes | control-plane | `organization:accounts:suspend` |
| `POST {base}/admin/organizations/:organizationId/reinstate` | Lift a tenant's suspension | control-plane | `organization:accounts:suspend` |
| `DELETE {base}/admin/organizations/:organizationId` | Delete a tenant: soft and restorable by default, hard to purge now | control-plane | `organization:accounts:delete` |
| `POST {base}/admin/organizations/:organizationId/restore` | Restore a deleted tenant inside its window, with every membership it had | control-plane | `organization:accounts:delete` |

**`slug` is optional on `POST {base}`, and who may pick one is a setting.** Send one and it behaves as it always has: held to the column's rule, unique across every organization, and a collision refuses rather than renaming — an address somebody picked is theirs to keep or to be told is gone. Omit it and the server derives one from the name.

Derivation is the column's own rule — lowercase alphanumerics joined by single hyphens, bounded at 64 — and **a collision retries with a suffix rather than checking first.** Asking whether `acme-games` is free and then inserting it is a question whose answer expires before the statement runs, and two people founding *Acme Games* in the same second is the ordinary case for a name. The unique index is the arbiter; the migration says so at the column.

A name that reduces to nothing keeps a short name of its own. `Café Ñandú` is `cafe-nandu` and `Ærø` is `aero`, because Unicode and a short table of the Latin letters it does not decompose say so. A name with no Latin letters in it at all — Chinese, Russian, Greek, Arabic, Hebrew, Thai — gets a stable token derived from that name, distinct per name. There is no transliteration table, deliberately: one for two scripts and not the other twenty is a promise half kept, and what matters is that the short name exists, is the caller's alone, and is the same one tomorrow. The alternative is what it replaces — `name.toLowerCase().replace(/[^a-z0-9]+/g, "-")` reduces all of those names to one base, and a shared base can be exhausted.

`deriveSlug` is importable from `@pithy-sh/organization/src/data/slug` for a form that wants to show the short name before it exists. It is a preview and never the decision: the server derives it again, and the constraint settles it.

**`slugs: "derived"` refuses a supplied short name**, naming the field, for a product where no URL contains one. Generating it in the browser instead would make derivation a convention: this route is reachable by anybody signed in, so any other client can still post any slug, take short names, and put a string it chose into an account's audit facts. The default is `"chosen"`, so nothing changes for a project that does not set it.

**`POST {base}` refuses everybody when `allowSelfService` is false**, rather than gating on a power nobody holds. There is no organization in force yet and therefore no role to read, so the only honest shape of that setting is a route that says no to every caller — the operator included, who provisions through their own code with an actor they can name. It also does not move the acting selection: creating a second account from a settings pane must not silently move somebody out of the one they were working in.

**The three ownership routes mount only where a project declares the pair of roles a transfer moves.** A catalog with no two-party transfer has no ownership surface at all, rather than one that answers 404 for reasons a client has to guess.

Two read scopes rather than one, because these are two blast radii: the account list is names and counts, and a roster is your customers' addresses. `scopeCovers` matches exactly, so holding the first confers nothing about the second.

## Membership administration

Support can act on an account through the control plane: add or remove a member, change a role, force ownership when the owner is gone, fix an invitation, and hold a seat limit. The routes are the eight rows of the table above from the `PATCH` of a tenant to the forced transfer.

**Every one takes a reason, and every one is audited.** The reason is a required field of the JSON body — a `DELETE` included, because the control-plane token signs the body — and of the query on the invitation listing. It is at most 500 characters and may not contain an email address, because the trail refuses addresses; name a member or an invitation by its id. Each act writes an `organization/admin_*` audit event with `actorType: "control-plane"`, the token's `sub` as the actor, the connection, the reason, the tenant, and the membership, invitation or organization it was done to.

**Three write scopes, separate from the reads and from each other.** `organization:members:write` covers who is in an account: add, remove, change a role, and list, resend or revoke an invitation. `organization:accounts:write` covers what it is: its name, its short name, its seat limit. `organization:ownership:transfer` covers who owns it, and only the ownership route exercises it. A control-plane token is minted for one scope and exercises that one, whatever else its connection was granted, so a roster call never carries the transfer scope: an add at the owning role, a role change to or from it, or the removal of an owner is refused 403 with `controlplane/insufficient_scope`, naming the ownership route in `params.ownershipRoute`, even on a connection granted both. Otherwise a roster token could add a second owner and remove the first, with no ownership-scoped call, no forced-ownership event and no notice to the new owner. The refusal is written to the trail as `controlplane/call_denied`, like any other scope refusal. A client holding only the read scopes is refused 403 on all eight. An organization id that names no account is a 404 on every one, and so is the read roster's.

**The last owner stays.** The owner is the role your `ownership` pair confers. Removing or demoting the last one is refused with `organization/last_owner` (409), and the refusal names the route that moves ownership in `params.ownershipRoute`. An account with no owner is the state this surface exists to get out of. The last administrator stays too, on the member surface's own floor. Both rules are carried in the write, so two concurrent removals cannot both land, and so is the role each write was decided from: a member made the owner while their removal or role change was running is refused with `core/conflict` (409) rather than removed or changed under a member's rules. A project with no `ownership` pair has no owner and no forced-ownership route; the administrator floor is the only one.

**An add is a membership, not an invitation.** The user must already have an account: an unknown `userId` is a 404. Somebody already in the account is refused with `organization/already_member`, naming the role they hold. The role may be any role the catalog declares but the owning one, `unassignable` ones included, and so may a role change; a role the catalog does not declare is refused, listing the ones it does. Ownership moves through the forced-ownership route alone.

**Forcing ownership moves it now.** No nomination and no acceptance. `previousOwner: "keep"` demotes whoever held it to the role the pair falls back to; `"remove"` ends their membership and their selection. Any standing offer is spent. The event is recorded at `warning`, and each previous holder gets an event of their own naming them, with the same reason: `organization/admin_member_removed` for `"remove"`, `organization/admin_member_role_changed` for `"keep"`, each with `forcedOwnershipTo` set to the new holder's membership. A nominee who leaves the account while the transfer runs takes nothing with them: the batch is conditional on their membership, so it changes nothing and answers 404.

**An owner whose tenure an operator ends takes their offers with them.** Forcing ownership away from an owner, kept or removed, spends any offer of ownership they made in the same write, so its nominee cannot take the account from the new owner.

**A seat limit is stored on the account** (`seatLimit`, set with `PATCH`; `null` lifts it). An add that would exceed it is refused with `organization/seat_limit_reached`, naming the limit, unless the request sets `overrideSeatLimit: true` — then it lands, and the audit event records `overrodeSeatLimit: true`. An invitation accepted against a full account is refused the same way, and the offer stays pending until a seat frees. Lowering the limit below the roster removes nobody.

**Changing the short name is an operator's act alone.** A short name another account holds is refused with `organization/slug_taken`, naming that account.

**Resending an invitation issues a fresh link, expired or not, and the old one stops working.** Revoking one makes its link unusable. Listing them is under the write scope, because the list is addresses and it is read to fix one; the read is audited with its reason.

**The people affected are told.** A member an operator added or removed, and a new owner, each get a notice through `@pithy-sh/email` — `organizationMemberAdded`, `organizationMemberRemoved`, `organizationOwnershipTransferred` — in their own language. A previous owner removed by a forced transfer is told they were removed. The operator's reason is never in the mail. Each is switchable off:

```ts
organization({
  roles,
  ownership: { confers: "owner", demotesTo: "admin" },
  // All three send by default.
  operatorEmails: { memberAdded: true, memberRemoved: true, ownershipTransferred: true },
});
```

With no email composed nothing is sent and nothing is refused: the change has already happened, and the audit event records `mailed: null`.

**`ORGANIZATION_ROUTES` in `src/http/routes.ts` is the registry this table mirrors**, and `routeContract.test.ts` compares that registry against what Hono actually mounted, in both directions, then calls every route with no credential and asserts which gate answered. A route added without an entry is a route whose verification nobody declared; an entry naming a route nobody mounts is a promise to a client that 404s.

## Suspending and deleting an organization

An operator can suspend, reinstate, delete and restore an organization through the last four rows of the table above, each with a reason. Nobody can act in a suspended or deleted organization, and it is gone from every member's list: a member's request to act in a suspended one is refused with `organization/organization_suspended` (403), and a deleted one answers `organization/not_found` (404), to a member as to a stranger. Either way their selection of it is cleared. **A member of several organizations carries on in the others, unchanged** — the suspended one simply stops being theirs. A cascade to members' own accounts is opt-in, `members: "sole"`, and reaches only those whose one and only organization this is. Deletion is soft by default, with a window and a restore, and a purge erases a deleted organization from every composed capability that declares an organization purge contribution — in the kit, organization, media and storage. [`docs/organization-lifecycle.md`](docs/organization-lifecycle.md) has the rules, the purge Workflows to export, and the config.

## What this deliberately does not do

**Permission scopes.** A power is what a *role* holds, and nothing grants one to a single person. `AuthContext.scopes` is a different seam: an attestation about the caller — *this write came from your trusted backend* — filled by `@pithy-sh/auth`'s `resolveScopes`, never a permission on a user and deliberately not an array smuggled onto the membership row. `packages/auth/docs/server-authoritative.md` covers it.

**Teams, or organizations inside organizations.** Neither the dashboard nor the academy has them, and a nesting nobody needs is a second tenancy boundary that every query then has to remember.

**Billing mechanics.** `@pithy-sh/payments` already bills an organization subject. This capability answers *which* organization, and nothing about money. `billing:manage` is a power over the account's billing relationship, not a payment rail.

**SSO, SCIM, or domain-based auto-join.** An address matching a domain is not consent, and every one of those is an identity-provider integration wearing a tenancy costume.

**Preferences, and profiles.** What a product lets people prefer — a timezone, a date format — and how a device, an account and a person layer is specific to the product; nothing generalizes without inventing an app's settings for it. A display name and an avatar are identity rather than tenancy, are wanted by single-tenant apps too, and are [#564](https://github.com/pithy-sh/pithy/issues/564): somebody in two accounts is the same person in both.

**A hand-written join on `pithy_auth_users`.** The roster resolves through `@pithy-sh/auth`'s published reader. That table belongs to another capability, versioned on its own cadence, and a join across that line is a schema dependency nobody declared.

## Why not Better Auth's `organization()`

Because tenancy is not identity, a role is decoded rather than asserted, and a 404 that can be told from a 403 is an existence oracle. The full argument, with what the plugin does instead and why each of those is the wrong answer *here* without being a wrong answer in general, is in [`docs/why-not-better-auth-organization.md`](docs/why-not-better-auth-organization.md).

The plugin stays supported. Deprecating it is a separate issue, and composing both in one Worker is refused at boot — two membership models is two answers to "may this person act".

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
