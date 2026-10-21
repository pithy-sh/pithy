# Account lifecycle

An account can be suspended or deleted. The kit holds the state, enforces it at every door, records every transition, and sends the mail. The routes that suspend, delete, restore and export arrive with their own issues, and so does the purge that erases a deleted account's data: the suspend routes with #621, the delete, restore and export routes and the purge Workflow with #622. This page is the seam they are built on.

## Two states

| State | Columns | What it means | Ends |
|---|---|---|---|
| Suspended | `suspended_at`, `suspended_until` | The account cannot sign in, refresh a token, or act on any route. | At `suspended_until`, by itself, or when an operator reinstates it. |
| Deleted | `deleted_at`, `purge_after` | The same, and its data is due for erasure once the purge window closes. Restorable until then. | When it is restored, or when the purge erases it. The purge arrives with #622; until then a deleted account stays deleted and its rows stay where they are. |

Both live on `pithy_auth_users`, so a session read already carries them. An account in good standing costs no extra read, and neither does refusing a deleted one. Refusing a suspended account costs one: the operator's reason is read from `pithy_auth_user_lifecycle`, on every refused request. A deleted account outranks a suspension it was already under. A suspension past its `suspended_until` is not a suspension, and nothing has to be written to end it.

No client can write its own state. The four columns are `input: false`, and only the kit's transitions set them.

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

`pithy_auth_user_lifecycle` holds every transition: the action, the actor, the reason, the time. The columns say what is true now; the table says what happened and who did it. The two are written in one transaction, so neither is ever there without the other. It has no foreign key to the user, because a purge erases the user row and this record must outlive it. It is the one `pithy_auth_*` row the purge will leave behind.

A transition that finds the account already where it was asked to put it does nothing: no row, no event, no mail, no hook. A suspension past its end counts as no suspension, so reinstating it is nothing too. A deleted account cannot be suspended or reinstated; restore it first, and its suspension is still there to lift.

Each transition also writes an audit event: `auth/admin_user_suspended`, `auth/admin_user_reinstated`, `auth/admin_user_soft_deleted`, `auth/admin_user_restored`, `auth/admin_user_purged`, and `auth/user_self_deleted` when the account's holder deletes it.

## Scopes

Reading a user, ending their access, and erasing them are three grants, beside `auth:users:read`:

- `auth:users:suspend` — suspend and reinstate.
- `auth:users:delete` — delete, restore, and start a purge.
- `auth:users:export` — everything the kit holds about one account, for an access request.

None of them is implied by another. See [CONTROL-PLANE.md](../../../docs/CONTROL-PLANE.md) for how a connection is granted one.

## Config

```ts
auth({
  baseURL: "https://api.example.com",
  // How long a deleted account waits before the purge erases its data (the purge lands in #622). 30 when nothing says otherwise.
  retention: { purgeAfterDays: 30 },
  // All four send by default. Turn one off by setting it to false.
  lifecycleEmails: { accountSuspended: true, accountReinstated: true, deletionScheduled: true, deletionComplete: true },
});
```

## Mail

Four templates in `@pithy-sh/email`, all transactional, so an unsubscribe never silences them: account suspended, account reinstated, deletion scheduled, deletion complete. Each says what happened and what it means. Account suspended and deletion scheduled also say who to answer: a reply, which reaches your sending address. Account reinstated and deletion complete say nothing about who to answer; add that to your own copy if your people need it. Deletion scheduled carries the date the purge is due. Deletion complete carries the date it ran. Each is written in the account's own language, dates included.

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

Each fires once per transition. A call that finds the account already where it asked to put it fires nothing. A hook that throws is logged and changes nothing: the transition is already written.

## Screens

Three screens ship with auth and are yours after `pithy ui add react`: account suspended, account deleted, and organization suspended. Each says what happened, what it means, and who to ask, in its own English. None renders a reason or a date from its URL, because anybody can write a URL. The details are in the mail.

## The purge contribution

A hard delete has to reach rows other capabilities hold, and no foreign key crosses a capability. So each capability declares how one subject's rows are erased or anonymized, on the `Capability` contract:

```ts
import type { PurgeContribution } from "@pithy-sh/core/src/capability/purge";

const purge: PurgeContribution = {
  subject: "user",
  summary: "Deletes the user's drafts.",
  erase: async ({ subject, env }) => {
    // Remove or anonymize this user's rows. Succeed when there is nothing left to remove.
  },
};

defineCapability({ name: "app", requiredBindings: [], purge: [purge] });
```

Today the kit declares the contract and the window, and nothing calls `erase` yet. The purge Workflow arrives with #622. It will run every composed contribution as its own step, named for its capability, so a failure retries that capability alone. That is why there is at most one per subject per capability, and why `erase` must succeed when the rows are already gone. `defineCapability` refuses a contribution for a subject the kit does not know. Declare one on your own `app` capability for your own tables.
