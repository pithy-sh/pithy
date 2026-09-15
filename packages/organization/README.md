# @pithy-sh/organization

Tenancy in your own D1. Organizations, the people in them, the roles you declare and the powers those roles hold, invitations bound to an address, ownership that moves only when somebody accepts it, and a record of which account each session is acting in.

Every multi-tenant project on this kit writes this model, and the best implementation of it was sitting outside the kit — in `pithy-sh/dashboard`, which looked at Better Auth's `organization()` plugin and did not use it. This is that model, generalized. Its three fixed roles became a catalog you declare, because a coaching academy's `coach` and `student` are parallel where a dashboard's `member`, `admin` and `owner` nest, and a capability that assumed either shape refuses the other outright.

```sh
pithy add organization
```

**Documentation: [pithy.sh/docs/capabilities/organization](https://pithy.sh/docs/capabilities/organization).** Overview, adding it, using it, and the reference: roles and powers, the acting selection, invitations, ownership transfer.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

Three pages ship in the package as well, because each has to be readable from the code rather than only from a website: [`docs/roles.md`](docs/roles.md), where roles are defined, how two unrelated role sets coexist, and which parts of a catalog can still be changed after somebody has joined; [`docs/scoping-your-own-tables.md`](docs/scoping-your-own-tables.md), the pattern that keeps *your* tenanted tables scoped — which this capability cannot do for you, because it has no view of them; and [`docs/why-not-better-auth-organization.md`](docs/why-not-better-auth-organization.md), the record of why this model rather than Better Auth's plugin.

## The seam

Three gates, composed on the route line. Nothing is implicit: a route that did not mount `requireOrganization()` has no organization, and a route that did has one that was proved on this request.

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { requireAuth } from "@pithy-sh/auth/src/http/middleware";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import { requireOrganization, requirePower } from "@pithy-sh/organization/src/http/guard";
import { organizationDatabase } from "@pithy-sh/organization/src/data/tables";
import { roles } from "./organization/roles";

const deps = {
  catalog: roles,
  database: (env: Record<string, unknown>) => organizationDatabase(env.DB as D1Database),
};

app.get(
  "/coaches",
  requireAuth(),
  requireOrganization(deps),            // fills c.var.acting, or 404s
  requirePower("sessions:read", deps),  // asks the matrix, or 403s
  zValidator("query", ListCoaches, validationHook),
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

`defineRoles` closes the kit's five power names, opens yours under your own names, and carries the literals through: `c.var.acting.role` narrows to the roles as written, and `requirePower` refuses a power nobody declared at compile time rather than denying everyone at runtime.

### A catalog that nests

The dashboard's own, and its seven powers decompose with nothing left over — the kit's five, plus two that exist because that particular product calls customers' Workers.

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

`unassignable: ["owner"]` is why a new organization here has no owner. Ownership is who pays the bill and signs, so it is accepted rather than conferred — it moves only by a two-party transfer — and the founder of an account gets the first role that administers and *may be assigned*, which is `admin`. Such an account works: it can be administered, invited into, read and renamed. It cannot be billed, which is the model saying out loud that nobody has yet agreed to pay for it.

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

No `unassignable`, so every role including `owner` may be handed to somebody, and the founder of an academy is its owner. Nothing about this catalog is a degraded case of the first one: it is a different shape, and the only thing the two share is the five powers the kit's own routes gate on.

## Routes

`{base}` is the configured `basePath`, `/organizations` by default. Everything under it answers JSON.

## Clear the acting selection when a session ends

The acting selection is keyed by session id, so it has to go when the session does. Nothing here can
see a sign-out — tenancy depends on auth, not the reverse — so the project that composes both wires it:

```ts
auth({
  // Fires on a sign-out, a revoke, an admin ending somebody's devices: anything that deletes the row.
  onSessionRevoked: async ({ id }) => {
    await clearActing(organizationDatabase(env.DB), { sessionId: id });
  },
}),
```

Without it the row outlives the credential that made it, one per sign-in, in a table with no TTL and no
sweep. It confers nothing — every read re-joins memberships and matches the user id too — so this is
growth rather than an access question, and it is still the kind of growth nobody notices until it is
large.

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
| `GET {base}/invitations/:token` | What an invitation is offering, for the accept screen | public | — |
| `POST {base}/invitations/accept` | Accept one, as the address it names | session | — |
| `POST {base}/current/ownership` | Offer ownership to a member | session | holding the account, or — where nobody does — volunteering yourself, if you administer it |
| `DELETE {base}/current/ownership` | Withdraw the standing offer | session | holding the account, or the offer being your own |
| `POST {base}/ownership/accept` | Accept ownership, and become the one who pays | session | — |
| `GET {base}/marks/organization/:organizationId` | An organization's stored mark, cacheable | session | — (membership) |
| `GET {base}/members/:membershipId/image` | A member's stored image | session | `organization:read` |
| `GET {base}/admin/organizations` | Every tenant, with how many people are in each | control-plane | `organization:accounts:read` |
| `GET {base}/admin/organizations/:organizationId/members` | One tenant's roster, with addresses | control-plane | `organization:members:read` |

**`slug` is optional on `POST {base}`, and who may pick one is a setting.** Send one and it behaves as it always has: held to the column's rule, unique across every organization, and a collision refuses rather than renaming — an address somebody picked is theirs to keep or to be told is gone. Omit it and the server derives one from the name.

Derivation is the column's own rule — lowercase alphanumerics joined by single hyphens, bounded at 64 — and **a collision retries with a suffix rather than checking first.** Asking whether `acme-games` is free and then inserting it is a question whose answer expires before the statement runs, and two people founding *Acme Games* in the same second is the ordinary case for a name. The unique index is the arbiter; the migration says so at the column.

A name that reduces to nothing keeps a short name of its own. `Café Ñandú` is `cafe-nandu` and `Ærø` is `aero`, because Unicode and a short table of the Latin letters it does not decompose say so. A name with no Latin letters in it at all — Chinese, Russian, Greek, Arabic, Hebrew, Thai — gets a stable token derived from that name, distinct per name. There is no transliteration table, deliberately: one for two scripts and not the other twenty is a promise half kept, and what matters is that the short name exists, is the caller's alone, and is the same one tomorrow. The alternative is what it replaces — `name.toLowerCase().replace(/[^a-z0-9]+/g, "-")` reduces all of those names to one base, and a shared base can be exhausted.

`deriveSlug` is importable from `@pithy-sh/organization/src/data/slug` for a form that wants to show the short name before it exists. It is a preview and never the decision: the server derives it again, and the constraint settles it.

**`slugs: "derived"` refuses a supplied short name**, naming the field, for a product where no URL contains one. Generating it in the browser instead would make derivation a convention: this route is reachable by anybody signed in, so any other client can still post any slug, take short names, and put a string it chose into an account's audit facts. The default is `"chosen"`, so nothing changes for a project that does not set it.

**`POST {base}` refuses everybody when `allowSelfService` is false**, rather than gating on a power nobody holds. There is no organization in force yet and therefore no role to read, so the only honest shape of that setting is a route that says no to every caller — the operator included, who provisions through their own code with an actor they can name. It also does not move the acting selection: creating a second account from a settings pane must not silently move somebody out of the one they were working in.

**The three ownership routes mount only where a project declares the pair of roles a transfer moves.** A catalog with no two-party transfer has no ownership surface at all, rather than one that answers 404 for reasons a client has to guess.

**Both control-plane routes are reads, and there is no management write.** Every mutation here is an administrative act inside one account, audited against the membership that took it, and a control-plane credential holds no membership by design — so a management write would be a change to somebody's roster attributed to nobody, in the one table an adopter reads to find out who did what. The operator's path is your own code, calling the store functions with an actor it can name.

Two scopes rather than one, because these are two blast radii: the account list is names and counts, and a roster is your customers' addresses. `scopeCovers` matches exactly, so holding the first confers nothing about the second.

**`ORGANIZATION_ROUTES` in `src/http/routes.ts` is the registry this table mirrors**, and `routeContract.test.ts` compares that registry against what Hono actually mounted, in both directions, then calls every route with no credential and asserts which gate answered. A route added without an entry is a route whose verification nobody declared; an entry naming a route nobody mounts is a promise to a client that 404s.

## What this deliberately does not do

**Permission scopes.** A power is what a *role* holds. A scope granted to one person, or to one credential, is a different seam and a separate issue — and deliberately not an array smuggled onto the membership row.

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
