# Why not Better Auth's `organization()`

_The reader's version of this page is [pithy.sh/docs/capabilities/organization/why-not-better-auth](https://pithy.sh/docs/capabilities/organization/why-not-better-auth). This copy ships in the package because it is the record of a decision, and a record that lives only on a website is one nobody finds from the code._

This decision has now been made twice — once in `pithy-sh/dashboard`, which examined the plugin and built its own model, and once here — and it was written down neither time. Only the consequences survived, as design notes on individual modules. So the next person to ask "why are we not just composing `organization()`" had nothing to read, and their two options were to re-derive the argument or to quietly revert to the plugin.

This is the argument. Disagree with it on purpose.

## What is not being claimed

The plugin is good software. It is more featureful than this capability in several directions that matter — teams, dynamic access control, organization-scoped roles stored as rows — and it is the right answer for a large number of products, including products built on this kit.

**It stays supported.** `pithy migrate` derives its three tables, `@pithy-sh/payments` documents reading `activeOrganizationId` off the session, and none of that changes when this capability lands. Deprecating it is a separate issue, and it may well not happen.

What follows is one argument about one property: **what a membership is worth when it is transitively a credential to somebody else's data.** In the dashboard, a membership reaches connections to customers' production Workers. In a coaching academy, it reaches minors' contact details. Where that is the stake, six answers have to come out a particular way, and the plugin answers them differently — not carelessly, and mostly for defensible reasons of its own.

Every claim below is checked against `better-auth@1.7.1`, the version this kit pins, and names the file it came from. A later release can make any of them untrue. The right response to that is to check, not to re-derive.

## 1. Tenancy is not identity

`auth` says who is signed in. The auth capability fills it for every request carrying a credential, and it is a fact about a person.

`acting` says what they are entitled to **here**. It exists only where a gate has proved it, and it is a fact about a person *and* an organization, on this request.

Merging them makes "signed in" and "a member of this organization" one condition, and the whole point is that they are two. It is the same reason core keeps `controlPlane` separate from `auth` rather than treating a management client as a very privileged user. So `c.var.acting` is a second context variable, non-optional downstream of `requireOrganization()` and absent everywhere else — and a test asserts the absence rather than trusting the type.

The plugin's shape is the other one, structurally rather than by oversight. Its tables are the auth schema's tables, the active organization is a column added to the session row, and its refusals are auth's refusals. Tenancy lives inside identity because tenancy is a plugin of the identity library. That is a coherent place to put it, and it is a place where "who you are" and "what you may do here" are one subsystem with one set of failure modes.

## 2. A role is decoded, not asserted

The membership's `role` column is text in both models, and it has to be: the catalog belongs to the adopter and is not known when the schema compiles.

What differs is what happens to a value nobody recognizes.

In this capability, every read parses the column through the catalog's own enum. An unrecognized value throws — the same 404 as a non-member, with the junk role in `detail` where the log keeps it. The refusal happens while there is still a request to refuse.

In the plugin, `member.role` is `z.string()` (`dist/plugins/organization/schema.mjs`), and the check is `acRoles[role]?.authorize(permissions)?.success` (`dist/plugins/organization/permission.mjs`). An unknown role falls through the optional chain and the function returns false. It denies — today.

**A deny that falls out of a missing lookup is not a rule.** Nothing states it, nothing logs it, and nothing tests it, because there is nothing there to test. One refactor later — a default branch, a fallback role, a merge of stored and configured roles — and the same value allows. That is the failure being designed out, and it is the dashboard's own sentence: *a role that matches no branch in the power matrix would deny everything today and, one refactor later, allow it.*

The column also carries a comma-separated list, split at check time (`input.role.split(",")`). That is a real feature — multi-role membership — and it is also one more shape a repair script or a seed fixture can put in a text column that nothing validates.

**A correction to the record, because it has been stated wrongly.** The plugin is often described here as having no power matrix. It has one. `createAccessControl` takes statements of your own — resources and the actions on them — and `organization({ ac, roles })` wires them in; the defaults cover `organization`, `member`, `invitation`, `team` and `ac` (`dist/plugins/organization/access/statement.mjs`). "No power matrix" was not true at 1.7.1, and repeating it makes this whole argument easier to dismiss than it should be. The difference is not that the plugin lacks a matrix. It is what the matrix does with a role it has never heard of.

## 3. A non-member gets the 404 for "no such organization", byte for byte

This is the single most important line in the package, and it is the one place the two models are simply incompatible.

A caller who can tell "that organization does not exist" from "that organization exists and you are not in it" holds an existence oracle. Iterate it and you have read out the tenant list — which, for a B2B product, is the customer list, and for the dashboard is a list of companies whose production systems somebody administers. So both facts throw one error with one message, and the distinction rides in `detail`, which the HTTP codec strips and the log keeps.

The rule only holds if every producer uses it, which is why there is one factory function and one place membership is resolved.

The plugin answers the two separately, on the same route. `GET /organization/get-organization?organizationSlug=…` returns `400 ORGANIZATION_NOT_FOUND` when no organization holds that slug, and `403 USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` when one does (`dist/plugins/organization/routes/crud-org.mjs`). Different status, different code, different message. And `POST /organization/check-slug` answers whether a slug is taken as a first-class endpoint.

**That is a deliberate design, not a bug, and it is right for a great many products.** Slug availability has to be answerable to build a sign-up form, and a product whose organizations have public pages — a GitHub, a Linear, anything with a vanity URL — loses nothing by saying which slugs exist, because the slugs are already public. The plugin is built for that product.

It is the wrong answer where the tenant list is confidential. There is no configuration that changes it, and layering a proxy in front to normalize two status codes into one is the kind of fix that holds until somebody adds a route.

## 4. The selection is a preference; the membership is the authority

A person may belong to several organizations and acts in one at a time. Where that answer lives decides how it can be got wrong.

Here it is a row keyed by the session, holding the user id beside it, and it is **never authority on its own**: every read rejoins memberships in the same statement. So deleting a membership row is the whole of revocation. It takes effect on the next request, with no sign-out, no cache to expire and no cleanup job — and a selection whose membership is gone is treated as no selection rather than a refusal, because being removed from one account is not being removed from the product.

The plugin's own endpoints re-read the member row too; `has-permission` calls `findMemberByOrgId` per request, and `get-organization` nulls the session column when the membership is missing. Credit where it is due: the role is not cached in a claim there either.

**The exposure is in the adopter's own routes, not in the plugin's.** What the plugin hands your code is `session.activeOrganizationId` — one nullable column on the session row (`pithy_auth_sessions.active_organization_id`). Its session middleware requires a session and nothing more (`dist/plugins/organization/call.mjs`); it does not re-prove that column against a membership. So a handler of yours that filters your own tables on `session.activeOrganizationId` is filtering on a value written when the choice was made, and it keeps serving somebody whose membership was deleted an hour ago until some *other* endpoint happens to notice. Writing the join yourself fixes it, on every route, forever — which is a rule that holds until somebody adds a route.

**And one nullable column cannot say whether anybody chose.** `chosen` is the difference between *somebody picked this* and *this is the only account you have*, and it is what a chooser keys on: one membership goes straight through with no picker and still writes the selection, several render the picker, none renders its own state. A single id has one value for all three arrivals.

## 5. One predicate, both halves

The user and the organization are matched in the same `where`. Not two queries, not a check followed by a read — one statement naming both.

The two obvious bugs are a filter on the selection that forgets the user and a filter on the user that forgets the selection. Neither throws. Both return a real row attached to the wrong organization, and the request that triggers one looks exactly like a request that worked. Writing the predicate as a pair means there is no shape of the code in which a caller passes the membership check for one organization and acts on another, and the acting table carries `user_id` beside `session_id` for the same reason: a session id is not a secret to that row.

The plugin's own lookups name both halves as well. This is not a point against it — it is the rule this capability holds structurally and enforces in one module, where the plugin holds it per endpoint. The difference shows up again in your code rather than in theirs: a model that hands you a bare id invites a query that filters on the id alone.

## 6. The floor counts a power, not a name

"This account always keeps somebody who can administer it" is an invariant, and it has to count something.

Here it counts holders of `administrativePower`, which the catalog names explicitly. So an account with one owner and one admin does not become unadministrable when the admin goes — the owner holds the administrative power too — and a fourth role declared next year that carries it is governed by the invariant the day it is declared.

The plugin counts the role spelled by `creatorRole`, default `"owner"`, by string comparison, in three places (`dist/plugins/organization/routes/crud-members.mjs`). An organization whose owner leaves an admin behind is refused, even though that admin can do everything. A catalog where administration is not spelled `owner` gets no floor at all unless `creatorRole` is set to match.

Counting a name is simpler and reads fine in the default three-role setup. It stops reading fine the moment the roles are yours.

## Where the plugin is the right answer

Reach for `organization()` when tenant existence is public anyway, when the roles are close to its defaults, when you want teams or organization-scoped roles stored as rows, or when you want one library to own identity and tenancy together and would rather have one upgrade path than two. It is well-built, it has a typed client half, and composing it costs one line.

Reach for this capability when a membership is a credential to data somebody else owns, when the tenant list is confidential, when the roles are a vocabulary of your product rather than a variation on owner/admin/member, or when you want the gate on the route line where a test can audit it.

## Both at once is refused at boot

Composing this capability alongside Better Auth's `organization()` fails to assemble, naming both. Two membership models in one Worker is two answers to "may this person act", two sets of organization rows, and a role in two places kept in step by hand. A Worker that composed both would authorize out of whichever one the route's author happened to reach for.

The plugin stays supported on its own, with the kit's migrations still deriving its tables. Dropping it would be a breaking change for adopters already on it, and it is a separate issue.

## What would change this decision

Named, so this is a position that can be lost rather than one that can only be held. Any of these landing upstream is an argument for reopening the question.

- The plugin makes non-membership and non-existence indistinguishable on every endpoint, without a proxy.
- It refuses a role its catalog does not declare, rather than denying silently.
- It hands an adopter a resolved membership rather than a session column, re-proved per request.
- Its floor counts a named power rather than a role name.
- It carries the chosen-versus-defaulted distinction a chooser needs.

The first of those is the one that cannot be worked around from outside. The rest could be met by configuration, a wrapper, or a version bump — and if they were, this capability would be a wrapper over the plugin rather than a second model, which would be the better outcome.
