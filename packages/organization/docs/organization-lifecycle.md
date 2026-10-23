# Organization lifecycle

An organization can be suspended or deleted. The kit holds the state, enforces it at every door a member uses, records every transition, and tells the owners. An operator suspends, reinstates, deletes and restores an organization through four control-plane routes, below. A purge erases a deleted organization's data, once its window closes, from every composed capability that declares an organization purge contribution: in the kit, organization, media and storage. It has the shape a user's account lifecycle has (`@pithy-sh/auth`'s `docs/account-lifecycle.md`), and one rule of its own about members.

## Two states

| State | Columns | What it means | Ends |
|---|---|---|---|
| Suspended | `suspended_at`, `suspended_until` | Nobody can act in it. It is gone from every member's list. | At `suspended_until`, by itself, or when an operator reinstates it. |
| Deleted | `deleted_at`, `purge_after` | The same, and its data is due for erasure once the purge window closes. Restorable, memberships and all, until then. | When it is restored inside the window, or when the purge erases it. |

Both live on `pithy_organization_organizations`, so the read that already joins a membership to its organization carries them. A deleted organization outranks a suspension it was already under. A suspension past its `suspended_until` is not a suspension, and nothing has to be written to end it.

## What a suspension means for a member

**Nobody can act in a suspended organization.** A member whose session acts in it is refused with `organization/organization_suspended`, 403, on the next request, and their selection of it is cleared in the same request, so the request after finds nothing in force. A route that names the organization refuses its members the same way. Choosing it is refused too. A stranger still gets `organization/not_found`: the 403 only ever answers somebody already proved to be a member.

**It leaves every member's list.** The chooser lists what a person may act in, and a suspended or deleted organization is not that. Beside it, the list reports `suspended`: how many of the caller's own organizations are suspended. A member whose only organization is suspended has nothing to choose, and the count is what tells the chooser they are not somebody who belongs nowhere. A deleted organization is not counted.

**A member of several organizations carries on in the others, unchanged.** Suspending one organization reads nothing past it and writes nothing to anybody's account. Their memberships elsewhere, their selection of another organization, their sessions and their account all stand. The suspended one simply stops being theirs until it is reinstated.

`@pithy-sh/ui-react` ships the `organization-suspended` screen. The chooser sends a member there when their list is empty and `suspended` is not zero, and when the organization they pick was suspended after the list was drawn. Your own screens send them there the same way: `organizationRefusal(failure.code) === "suspended"`, from `@pithy-sh/organization/src/index`.

A deleted organization is refused as one that is not there: `organization/not_found`, to a member and a stranger alike, and every session's selection of it is cleared when it is deleted.

**It takes nobody in.** An invitation to a suspended or deleted organization reads as a dead offer, `organization/invitation_invalid`, both on the accept screen's read and on the accept itself, so no membership is written into a shut tenant. The offer stays pending: once the organization is reinstated or restored, the link works again until it expires.

## The member cascade

A suspension or a deletion may reach the people in the organization, and only on purpose: `members: "sole"`. The default, and what omitting it means, is `members: "none"`, which touches nobody.

**`sole` reaches only a member whose one and only organization this is.** A member of any other organization is never modified, whatever state that other organization is in. Writing "suspend the org and its users" naively would lock a person out of every other tenant they work in; this cannot.

**It runs through the user lifecycle, not around it.** A reached account is suspended, or deleted the way the organization is — soft or hard — by `@pithy-sh/auth`'s own transitions, with the organization's reason: the same columns, history row, `auth/admin_user_*` audit event, mail and hook an operator acting on that one person would produce. A hard cascade starts each reached account's purge, or leaves it to auth's daily pass. An account already suspended keeps its own suspension, its reason and its end. One already deleted is left as it is.

**The response says who was reached, who was not, and why.** `members.reached` lists each account suspended or deleted. `members.skipped` lists each member left alone: `member_elsewhere`, `already_suspended`, `account_deleted`, `no_account`, or `failed` when the user transition refused, which the log explains. The audit event carries the counts, never the people.

**Nothing undoes a cascade silently.** Reinstating the organization lifts nobody's own suspension, and restoring it restores nobody's account. Both responses list `membersStillShut`: every member whose own account is still suspended or deleted. Reinstate or restore each through `@pithy-sh/auth`'s own routes.

## The routes

| Route | Scope | What it does |
|---|---|---|
| `POST {base}/admin/organizations/:organizationId/suspend` | `organization:accounts:suspend` | Suspend it, until `until` or a reinstatement. A second call restates the reason and the end, keeping the start. |
| `POST {base}/admin/organizations/:organizationId/reinstate` | `organization:accounts:suspend` | Lift the suspension. No suspension in force is a 200 that changed nothing. |
| `DELETE {base}/admin/organizations/:organizationId` | `organization:accounts:delete` | Delete it. Soft by default; `mode: "hard"` purges now. |
| `POST {base}/admin/organizations/:organizationId/restore` | `organization:accounts:delete` | Restore it inside its window, with every membership it had. |

Every route takes a required `reason` in its JSON body, at most 500 characters and no email address, and writes an `organization/admin_organization_*` audit event with the operator, the connection, the reason and the tenant. An unknown `:organizationId` is a 404 on every one, never a 403. The two scopes are separate from each other and from every read and write scope; a client holding neither is refused 403 on all four. A deleted organization cannot be suspended or reinstated — restore it first; the refusal names the route — and its suspension is still there to lift after.

**Delete, soft**: shut now, gone from every list, every selection of it cleared, its memberships kept. `purge_after` is now plus `retention.purgeAfterDays`, 30 unless you set it. `purge` is `scheduled`. **Delete, hard**: the window closes now, nothing can restore it, and the purge starts in the same call — `purge` is `started`, or `pending` when this Worker binds no purge Workflow, and the daily pass starts it. A hard deletion of one already deleted softly brings its purge forward; `outcome` says `deleted`, `brought_forward` or `unchanged`.

**Restore** clears both columns inside the window. Its memberships were never removed, so every member sees it again. A suspension it was under is still in force, and the response says `state: "suspended"`. Once `purge_after` has passed it is a 409 naming the date. After the purge there is no organization: a 404, whose action says the data is gone.

The management listing, `GET {base}/admin/organizations`, says where each tenant stands: `state`, `suspendedUntil` and `purgeAfter`.

## The record

`pithy_organization_lifecycle` holds every transition: the action, the actor, the reason, the time. The columns say what is true now; the table says what happened and who did it. The two are written in one transaction. It has no foreign key to the organization, because a purge erases that row and this record must outlive it. A transition that finds the organization already where it was asked to put it writes no row and fires no hook.

## The purge

A purge erases one deleted organization from every composed capability that declares what erasing it means. It runs as a Workflow, **one step per composed purge contribution for the `organization` subject**, named for its capability, so a capability that fails retries alone and the steps that finished are not run again. Each step records that it ran in `pithy_organization_lifecycle`, with the contribution's summary. This capability's own step runs last, because the others may still read a membership: it deletes the organization, its memberships, invitations, ownership offer and selections, and your `onDelete` rows in the same batch. Then the `purged` record, `organization/purged`, and `onOrganizationPurged`, once.

Three kit capabilities declare one. Organization's own is above. `@pithy-sh/media` deletes every record whose `organizationId` is the organization's, with its bytes in R2, Cloudflare Images or Stream, and its dedup hashes. `@pithy-sh/storage` deletes every file whose `organizationId` is the organization's, with its bytes in R2 and every share link to it. Each deletes the bytes before the row, so a step that fails keeps the rows that say where the rest is, and retries. `@pithy-sh/payments` declares none: an organization's purchases and entitlements are billing records, and the purge leaves them. A capability that declares no contribution is not touched by the purge, whatever rows it holds, so declare one for your own tables on your `app` capability.

A capability holding rows scoped to an organization declares what erasing them means, beside its user contribution:

```ts
purge: [
  { subject: "organization", summary: "Deletes the organization's uploads.", erase: async ({ subject, env }) => { /* … */ } },
],
```

A daily cron at 02:00 UTC, the one auth's purge uses, starts the purge for every organization past its `purge_after`. The instance is named for the deletion and the UTC day, so a hard deletion and the daily pass start one purge, not two.

**The Workflows are yours to export**, for the reason auth's are: only the Worker that composes the capabilities has their contributions.

```ts
// apps/api/src/index.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { runOrganizationPurge, runOrganizationPurgeDue } from "@pithy-sh/organization/src/purge/workflow";

export class OrganizationPurgeWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runOrganizationPurge(this.env, event, step, NonRetryableError);
  }
}

export class OrganizationPurgeDueWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runOrganizationPurgeDue(this.env, event, step, NonRetryableError);
  }
}
```

```jsonc
// apps/api/wrangler.jsonc, in each environment's stanza
"workflows": [
  { "binding": "ORGANIZATION_PURGE", "name": "acme-prod-organization-purge", "class_name": "OrganizationPurgeWorkflow" },
  { "binding": "ORGANIZATION_PURGE_DUE", "name": "acme-prod-organization-purge-due", "class_name": "OrganizationPurgeDueWorkflow" }
],
"triggers": { "crons": ["0 2 * * *"] }
```

Until they are bound, deletions still shut the organization, a hard deletion reports its purge as `pending`, and nothing is erased.

## Config, mail and hooks

```ts
organization({
  roles,
  // How long a deleted organization waits before the purge erases it. 30 when nothing says otherwise.
  retention: { purgeAfterDays: 30 },
  // All three send by default. Turn one off by setting it to false.
  lifecycleEmails: { organizationSuspended: true, organizationReinstated: true, organizationDeletionScheduled: true },
  onOrganizationSuspended: async (event, d1) => {},
  onOrganizationReinstated: async (event, d1) => {},
  onOrganizationDeleted: async (event, d1) => {},
  onOrganizationPurged: async (event, d1) => {},
});
```

The owners are told: the members holding the role your `ownership` pair confers, or, with no pair, the members whose role holds `organization:delete`. Three templates in `@pithy-sh/email`, all transactional, in each owner's own language: `organizationSuspended`, with the reason and any end — the suspended screen tells every member the owners were told why; an owner a `sole` cascade reached is sent their own account's suspension notice instead, because this one says their account is unaffected — `organizationReinstated`, and `organizationDeletionScheduled`, with the date the data is erased. A hard deletion sends none. With no email composed nothing is sent and nothing is refused, and the audit event records `mailed: null`.

Each hook fires once per transition that happened, after it is written. A hook that throws is logged and swallowed, and the transition stands.
