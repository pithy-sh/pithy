# Account lifecycle

An account can be suspended or deleted. The kit holds the state, enforces it at every door, records every transition, and sends the mail. An operator suspends, reinstates, deletes, restores and exports an account through control-plane routes, below. A person deletes their own account from inside your app. A purge erases a deleted account's data from every capability that holds it, once its window closes.

## Two states

| State | Columns | What it means | Ends |
|---|---|---|---|
| Suspended | `suspended_at`, `suspended_until` | The account cannot sign in, refresh a token, or act on any route. | At `suspended_until`, by itself, or when an operator reinstates it. |
| Deleted | `deleted_at`, `purge_after` | The same, and its data is due for erasure once the purge window closes. Restorable until then. | When it is restored inside the window, or when the purge erases it. |

Both live on `pithy_auth_users`, so a session read already carries them. An account in good standing costs no extra read, and neither does refusing a deleted one. Refusing a suspended account costs one: the operator's reason is read from `pithy_auth_user_lifecycle`, on every refused request. A deleted account outranks a suspension it was already under. A suspension past its `suspended_until` is not a suspension, and nothing has to be written to end it.

No client can write its own state. The four columns are `input: false`, and only the kit's transitions set them.

**The admin reads say where each account stands.** `GET /auth/admin/users` and `GET /auth/admin/users/:userId` return each user with `state` — `active`, `suspended` or `deleted` — `suspendedUntil`, the end of a suspension in force or null for one with none and in every other state, and `purgeAfter`, the last day a deleted account can be restored or null otherwise. They are read the way enforcement reads them, so a suspension past its end is `active`. The listing does not leave a suspended or deleted account out, and these are what let a pane offer suspend or reinstate without sending a write to find out. Neither the reason nor who acted is there: the reason is on the trail, and the trail is audit's. Each field is optional in `AdminUserView`, so a client reading a Worker older than them still parses its answer.

## Enforcement

A refused request gets one of two errors, both 403:

- `auth/account_suspended` — the operator's reason is the `message`, and `params.suspendedUntil` names the end, as ISO-8601, when there is one.
- `auth/account_deleted` — `params.purgeAfter` names the last day it can be restored.

Not 401: signing in again cannot help. `clientError` strips `action` and `detail` from both, so a caller learns the state and the reason and nothing else. `@pithy-sh/i18n` carries each in Spanish, keyed by the code. The English is the `message`.

Where an account is refused:

- **Every request.** The session middleware gives a refused account no `AuthContext`, so every `requireAuth()` in the kit refuses it, whichever capability wrote the guard. This capability's own `requireAuth()` answers with the code. Another capability's copy answers 401, and the client's next refresh gets the code.
- **Every sign-in and every token refresh.** Magic link, OTP, each social provider and `/token/rotate` all create their session in one place, and that place refuses. A refused rotation spends nothing: the presented credential still works once the account is reinstated.
- **Better Auth's own endpoints.** `/token`, `/get-session` and the rest of what acts as the session's holder refuse too. Signing out always works, and a stale credential on a shared device never stops somebody else signing in.

A check that cannot be made refuses. If the read behind it fails, the request gets a `core/internal` 500 at every door above, never a session.

A magic link for a refused account returns to the screen it named, with the code as `?error=`. So does a social sign-in, to its `errorCallbackURL`. The callback and sign-in screens send the reader on to the screen for that state. So does the OTP screen, when a right code meets a refused account.

## The record

`pithy_auth_user_lifecycle` holds every transition: the action, the actor, the reason, the time. The columns say what is true now; the table says what happened and who did it. The two are written in one transaction, so neither is ever there without the other. It has no foreign key to the user, because a purge erases the user row and this record must outlive it. It is the one `pithy_auth_*` row the purge leaves behind.

A transition that finds the account already where it was asked to put it does nothing: no row, no event, no mail, no hook. The control-plane routes still record the call on the trail, as below. A suspension past its end counts as no suspension, so reinstating it is nothing too. A deleted account cannot be suspended or reinstated; restore it first, and its suspension is still there to lift.

Suspending an account that is already suspended is the one exception. It restates the suspension: the new reason and end replace the old, a row records them, and the mail and the audit event go out. The start stays, and no hook fires, because the account was suspended and still is.

Each transition also writes an audit event: `auth/admin_user_suspended`, `auth/admin_user_reinstated`, `auth/admin_user_soft_deleted`, `auth/admin_user_hard_deleted`, `auth/admin_user_restored`, `auth/admin_user_purged`, and `auth/user_self_deleted` when the account's holder deletes it. An export writes `auth/admin_user_exported`.

## Scopes

Reading a user, ending their access, and erasing them are three grants, beside `auth:users:read`:

- `auth:users:suspend` — suspend and reinstate.
- `auth:users:delete` — delete, restore, and start a purge.
- `auth:users:export` — everything the kit holds about one account, for an access request.

None of them is implied by another. See [CONTROL-PLANE.md](../../../docs/CONTROL-PLANE.md) for how a connection is granted one.

## Suspend and reinstate

Two routes, each gated by `auth:users:suspend`. A connection holding only `auth:users:read` is refused 403, and the scope is checked before the body is read.

```
POST /auth/admin/users/:userId/suspend     { reason, until?, notify? }
POST /auth/admin/users/:userId/reinstate   { reason, notify? }
```

The paths are under auth's `basePath` (`/auth` by default), which the manifest reports — not under `/control-plane`, which holds only the seam's own routes. `reason` is required on both: one sentence, at most 500 characters, written for the person, because a suspension's reason is what every refused sign-in shows them. A request without one is `validation/invalid_input`.

**Suspend** stamps the columns, writes the row, and then revokes every session the account holds. A refresh token is a session token, so it goes with them. Revoked after the columns, never before: a session alive in between meets `auth/account_suspended`. The person's held credential stops working, a refresh is refused, and signing in again answers `auth/account_suspended` with the reason. `until` is an ISO-8601 time in the future; one in the past is refused. The suspension ends by itself when it passes, with nothing written. Suspending a suspended account restates it, and the response says `outcome: "updated"`. The response carries the suspension in force, `sessionsRevoked`, and `mailed`.

**Reinstate** lifts the suspension. It restores no session: the person signs in again. An account with no suspension in force answers 200 with `outcome: "unchanged"`, and nothing is written.

Neither touches a deleted account. Both answer `core/conflict`, naming the restore route, because a deleted account is restored, not reinstated. An unknown `:userId` is a 404.

`notify` is true when absent. It sends the account-suspended mail, or the account-reinstated mail, through `@pithy-sh/email`. `notify: false` sends none. The config can turn a mail off for every call; `notify` turns it off for one.

Every call is audited, as `auth/admin_user_suspended` or `auth/admin_user_reinstated`, with the operator, the connection, the reason and the user id. A refusal is recorded as `denied` with its code — a body the validator turns away included, with whatever reason it carried — and a reinstatement that changed nothing as a success with `changed: false`. The sessions a suspension ends are recorded as `auth/admin_user_sessions_revoked`, `cause: "suspended"`.

## Delete, restore and export

Three routes. Deleting and restoring are gated by `auth:users:delete`, exporting by `auth:users:export`. Neither grants the other, and `auth:users:read` grants neither. The scope is checked before the body is read.

```
DELETE /auth/admin/users/:userId           { mode?, reason, notify? }
POST   /auth/admin/users/:userId/restore   { reason }
GET    /auth/admin/users/:userId/export?reason=…
```

`reason` is required on all three, on the same terms as a suspension's. A request without one is `validation/invalid_input`.

**Two modes, and soft is the default.** `mode: "soft"`, or no mode at all, stamps `deleted_at` and `purge_after` — now plus `retention.purgeAfterDays`, 30 unless you set it — and revokes every session the account holds. Signing in again answers `auth/account_deleted`. The deletion-scheduled mail goes out with the purge date and, when you configure one, the restore path. `onUserDeleted` fires. The account can be restored until `purge_after`. `mode: "hard"` closes the window now: `purge_after` is the moment of the deletion, nothing can restore it, and the purge starts in the same call. You name it on purpose. A typo — `"Hard"`, `"hrad"` — is a 400, never either mode. A hard deletion of an account already deleted softly brings its purge forward to now.

The response says what happened: `outcome` is `deleted`, `brought_forward`, or `unchanged` for an account already deleted. `purge` is `scheduled` for a soft deletion, `started` when this call started the purge, and `pending` when the account is due and this Worker binds no purge Workflow to start. `notify: false` silences the mail this call sends: the deletion-scheduled notice for soft, the deletion-complete notice for hard.

**Restore** clears both columns inside the window and records it. The person signs in again; no session comes back. A suspension the account was under before the deletion is still there, and the response says `state: "suspended"`. Once `purge_after` has passed the purge is due, so a restore is a 409 naming the date. The window is checked against the database's clock as the restore's write runs, the same clock the purge checks it against, so a restore and a purge that race always agree on which one won. A window that closes while a restore is in flight, or that a hard deletion brings forward, is the same 409. After the purge there is no account: a 404, whose action says the data is gone.

**Export** answers an access request. It returns one JSON document, validated by `AdminUserExportResponse` from `@pithy-sh/auth/src/http/responses`: the subject, when it was read, and one entry per composed capability that declares a purge contribution, in the order the purge runs them. Each entry says what a purge does with its rows — `disposition` is `erase` or `retain`, and a `retain` entry carries the `basis` it is kept on, in the sentence written for the person — and then what it answered: `exported` with that capability's data, `not_exported` when it erases rows it does not say how to export, or `unavailable` when its rows would not read. Every kit capability that holds rows about a person exports them, so `not_exported` is only ever an adopter's own capability; [what each one does](#what-each-capability-does-with-a-persons-rows) is below. Auth's own part is `AuthUserExport`: the account, its sessions, linked providers, devices, history, the sign-in links and codes the verification ledger records for it, and its rows in the user-keyed tables its Better Auth plugins created, and no credential — no session token, no provider token, no push token, no two-factor secret or backup code, no key. No kit capability's part carries one either: no opt-in token, no share link, no invitation digest, no provider payload, no Google Play purchase token, no message variables. It is audited as a disclosure, `auth/admin_user_exported`, with the operator, the reason, and which parts answered, never the data. An unknown or purged account is a 404.

Every call is audited, as for suspend and reinstate: a deletion under `auth/admin_user_soft_deleted` or `auth/admin_user_hard_deleted`, a restore under `auth/admin_user_restored`, with the operator, the connection, the reason and the user id. A refusal is `denied` with its code, and a call that changed nothing is a success with `changed: false`.

## Deleting your own account

```
DELETE /auth/account   { confirm: true }
```

The signed-in person deletes their own account. **This is the route the App Store and Google Play require**: an app that lets people create an account must let them delete it from inside the app. Put a button behind it in your settings screen, and send `confirm: true` once the person has confirmed. Without the confirmation it is a 400 and nothing moves.

It is always soft, on the configured window, and the subject is always the session's own: no field names an account, and a key that tries is dropped. Every session ends, this one included. It is audited as `auth/user_self_deleted`, with the person as the actor. A suspended account can still delete itself — a suspension is no reason to keep somebody who wants to leave. A deleted one is refused with `auth/account_deleted`.

**Signing in to leave.** A suspension ends every session and refuses every sign-in, so a suspended person holds no credential to call this route with. A sign-in that sends `x-pithy-intent: delete-account` is the way back in: the person signs in as usual, by code, link or provider, and the suspended account gets a session anyway. That session opens nothing else. Every other route, a token and a refresh included, still answers `auth/account_suspended`, and `DELETE /auth/account` is the one that admits it. When a sign-in answers `auth/account_suspended`, offer the person a delete button that signs in again with the header and then calls this route. A deleted account is refused with or without the header. The header only works on a sign-in request your app sends itself, such as the OTP or an ID-token sign-in. A browser redirect, such as a magic link or a web social callback, cannot carry it. CSRF-guarded in cookie mode, like every mutating route.

**The restore path.** A person who changes their mind inside the window cannot sign in to undo it, so the deletion-scheduled mail tells them how: its restore button links to `retention.restoreUrl` when you set one — an http(s) page of yours — and the mail always says to reply before the purge date. An operator restores the account from the management surface.

## The purge

A purge erases one deleted account from every capability that holds rows about it. It runs as a Workflow, **one step per composed purge contribution**, named for its capability, so a capability that fails retries alone and the steps that finished are not run again. Each step records that it ran in `pithy_auth_user_lifecycle`, with the contribution's summary. A contribution that **retains** its rows is a step too, and erases nothing: it records `purge_retained`, with the basis it gave as the reason, so the history never reads a kept step as an erased one. The order:

1. Is the account due — deleted, with its window closed? A restored account, one inside its window, and one already erased end the run here, having erased nothing. Re-running a purge for the same subject exits without error.
2. Every composed contribution but auth's, in composition order, your `app` last. Each reads the account's address, when it needs one, inside its own step.
3. The deletion-complete mail, **before the address is erased**: auth's rows, which hold it, are still there.
4. Auth's own: the user row, its sessions, linked providers, devices, refresh-token ledger, pending sign-in codes and its rows in the verification ledger, and its rows in every table a composed Better Auth plugin created with a `userId` column — a two-factor secret and its backup codes, a passkey, an API key. Its history stays — the one `pithy_auth_*` row left.
5. The `purged` record, `auth/admin_user_purged`, and `onUserPurged`, once — even when two purges of one account overlap.

A daily cron at 02:00 UTC starts the purge for every account past its `purge_after`, and for none before it. A hard deletion starts its own. Either way the instance is named for the deletion and the UTC day, so a hard deletion repeated, or one the daily pass also finds due, is one purge, and a purge that failed is started again by the next day's pass. A hard deletion's `notify: false` is saved with the deletion, so it holds when the daily pass is the one that starts its purge.

The `scheduled` handler starts only the jobs whose `schedule` is the cron that fired, so the daily pass runs once a day even in a Worker whose other jobs run hourly.

**The Workflows are yours to export.** A purge runs every composed capability's contribution, your own among them, and only the Worker that composes auth has them. So the two classes are five lines each in that Worker's entry, beside `createEntrypoint`, and their bodies are the kit's:

```ts
// apps/api/src/index.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { runAuthPurge, runAuthPurgeDue } from "@pithy-sh/auth/src/purge/workflow";

export class AuthPurgeWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runAuthPurge(this.env, event, step, NonRetryableError);
  }
}

export class AuthPurgeDueWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runAuthPurgeDue(this.env, event, step, NonRetryableError);
  }
}
```

```jsonc
// apps/api/wrangler.jsonc, in each environment's stanza
"workflows": [
  { "binding": "AUTH_PURGE", "name": "acme-prod-auth-purge", "class_name": "AuthPurgeWorkflow" },
  { "binding": "AUTH_PURGE_DUE", "name": "acme-prod-auth-purge-due", "class_name": "AuthPurgeDueWorkflow" }
],
"triggers": { "crons": ["0 2 * * *"] }
```

`pithy worker sync` leaves these entries and the cron where you wrote them, and `pithy deploy` does not count them against your app's own Workflows. Until they are bound, deletions still shut the account, a hard deletion reports its purge as `pending`, and nothing is erased. `c.var.workflows.trigger("auth/purge-due", {})` runs the daily pass on demand.

The purge audits from the Workflow through the composed audit capability, which provides a recorder for code with no request. With no audit capability composed, nothing is recorded, as for every other event.

## Config

```ts
auth({
  baseURL: "https://api.example.com",
  // How long a deleted account waits before the purge erases its data. 30 when nothing says otherwise. `restoreUrl`
  // is where the deletion-scheduled mail sends somebody who wants their account back: an http(s) page of yours.
  retention: { purgeAfterDays: 30, restoreUrl: "https://example.com/account/restore" },
  // All four send by default. Turn one off by setting it to false.
  lifecycleEmails: { accountSuspended: true, accountReinstated: true, deletionScheduled: true, deletionComplete: true },
});
```

## Mail

Four templates in `@pithy-sh/email`, all transactional, so an unsubscribe never silences them: account suspended, account reinstated, deletion scheduled, deletion complete. Each says what happened and what it means. Account suspended and deletion scheduled also say who to answer: a reply, which reaches your sending address. Account reinstated and deletion complete say nothing about who to answer; add that to your own copy if your people need it. Deletion scheduled carries the date the purge is due, and the restore button when `retention.restoreUrl` is set. Deletion complete carries the date it ran, and is sent before the address is erased. Each is written in the account's own language, dates included.

## Hooks

```ts
auth({
  baseURL: "https://api.example.com",
  onUserSuspended: async (event, d1) => {},
  onUserReinstated: async (event, d1) => {},
  onUserDeleted: async (event, d1) => {},
  onUserPurged: async (event, d1) => {},
});
```

Each fires once per transition. A call that finds the account already where it asked to put it fires nothing, and neither does restating a suspension. A hook that throws is logged and changes nothing: the transition is already written.

## Screens

Three screens ship with auth and are yours after `pithy ui add react`: account suspended, account deleted, and organization suspended. Each says what happened, what it means, and who to ask, in its own English. None renders a reason or a date from its URL, because anybody can write a URL. The details are in the mail.

## What each capability does with a person's rows

Every kit capability that holds rows about a person declares a `user` contribution, and every one exports what it holds. Most erase. Three keep their rows, because the law or the record needs them, and say why.

| Capability | Disposition | What |
|---|---|---|
| `auth` | erase | The account, sessions, providers, devices, refresh-token ledger, pending codes, verification ledger, plugin rows. Its lifecycle history stays. |
| `ledger` | erase | Balances in every currency, the transaction log, holds. |
| `rating` | erase | The rating in every pool. |
| `leaderboard` | erase | Entries on every board, in every window, what each session result put on them, and their moderation history. |
| `matchmaking` | erase | Invites sent or received, friendships and requests on either side, and the person's place, undelivered match and drop records in every game's queue. A room code expires on its own TTL. |
| `multiplayer` | anonymize | Session results: the person's id in the players, scores and winner is replaced, so the other players' results stay. |
| `support` | erase | Threads linked to the account, or sent from its address and linked to no other account, with messages, attachments, raw mail, classifications and read state. |
| `testers` | erase | Cohort memberships under the account's address, and their events. Cohort counts stay. |
| `artifacts` | erase | Repositories the person owns, with their contents and grants, and the grants they hold. |
| `media` | erase | Records the person holds as themselves, with their bytes and hashes. A record made for an organization is the organization's. |
| `storage` | erase | Files the person holds as themselves, with their bytes and share links. A file made for an organization is the organization's. |
| `organization` | erase | Memberships, the organization each session acted for, ownership offers made to or by them, invitations addressed to them. Invitations they sent and organizations' history keep their id; an organization they were the last owner of is left without one. |
| `payments` | retain | Purchases, entitlements, provider accounts, overrides, meter counters and usage reports of a user subject. *Kept for tax and accounting records, which the law requires a business to hold after an account is closed.* |
| `email` | retain | The address on the suppression list, and the log of mail sent to it. *Kept so your unsubscribe holds: the address stays on the list of addresses not to mail, with the record of what was sent to it.* |
| `audit` | retain | Every audit event where the person is the actor. *Kept as the record of who did what, which a security review or a dispute is read against.* |

`packages/cli/src/capabilities/personRows.test.ts` holds the kit to it. It constructs every capability package, walks its schema, and fails the build when a table names a person — `userId`, `ownerId`, `subjectId`, `actorId`, any `…UserId`, either side of an invite or a friendship, or an address — in a capability that declares no `user` contribution, or one without an export. `isPersonColumn` and `personRowGaps` in `@pithy-sh/core/src/capability/personColumns` are the rule, if you want to hold your own capabilities to it.

## The purge contribution

A purge has to reach rows other capabilities hold, and no foreign key crosses a capability. So each capability declares how one subject's rows are erased or anonymized, and what an export hands back, on the `Capability` contract:

```ts
import type { PurgeContribution } from "@pithy-sh/core/src/capability/purge";

const purge: PurgeContribution = {
  subject: "user",
  summary: "Deletes the user's drafts.",
  erase: async ({ subject, env }) => {
    // Remove or anonymize this user's rows. Succeed when there is nothing left to remove.
  },
  export: async ({ subject, env }) => {
    // What you hold about this user, as one JSON object. No credentials.
    return { drafts: [] };
  },
};

defineCapability({ name: "app", requiredBindings: [], purge: [purge] });
```

The purge runs every composed contribution as its own step, named for its capability, so a failure retries that capability alone. That is why there is at most one per subject per capability, and why `erase` must succeed when the rows are already gone: a step is retried after a failure that may have come once they were. Any fault in `erase` is retried with the platform's backoff, because the contract makes it safe to. `export` is optional; without one, the export lists the capability as `not_exported`. A throw from it costs its own entry, never the document. The kit knows two subjects, `user` and `organization` — the second for rows scoped to a tenant, which `@pithy-sh/organization`'s purge runs ([`organization-lifecycle.md`](../../organization/docs/organization-lifecycle.md#the-purge)) — and `defineCapability` refuses a contribution for any other. Declare one on your own `app` capability for your own tables.

**Or keep the rows, and say why.** Not every row about a person should go: a payment record is commonly kept for tax law, a suppression has to outlive the person or the unsubscribe stops holding, and an audit trail is the record of who acted. A contribution with `retain` is the third disposition beside erase and anonymize. It takes a basis, one sentence written for the person, and an `export`, which it may not leave out — rows that are kept are rows an access request is answered with — and no `erase`. `defineCapability` refuses one without a basis, without an export, or with an erase as well. The purge records the step as `purge_retained` and erases nothing; the export carries the rows, `disposition: "retain"` and the basis.

```ts
const kept: PurgeContribution = {
  subject: "user",
  summary: "Keeps the user's invoices.",
  retain: { basis: "Kept for tax records." },
  export: async ({ subject, env }) => ({ invoices: [] }),
};
```

**Rows found by address.** A step is handed `address`, a function that reads the account's address when called — `null` once it is gone. Call it inside `erase` or `export`; it is never carried in the Workflow's journal. Compare it in `normalizeAddress`'s form from `@pithy-sh/core/src/address/address`, the form the kit stores addresses in.

**Rows keyed by a column.** For tables whose rows name the person in a column and need nothing but reading out and deleting, `personRowsPurge` from `@pithy-sh/core/src/capability/personRows` writes the contribution: it exports every matching row decoded through its schema, and deletes them all in one batch. `personRowsExport` is its export alone, for a contribution that retains. A table's `omit` leaves columns out of the export, and its `redact` rewrites a row before that, for a credential only some rows hold — payments uses it to drop a Google Play purchase token from the columns a Play row keys on. `credentialFields` from `@pithy-sh/core/src/capability/purge` names every field in an export that holds a credential, so a test can assert there are none.
