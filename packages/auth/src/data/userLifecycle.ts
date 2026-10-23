// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * `pithy_auth_user_lifecycle` — every transition an account went through, who made it, and why.
 *
 * **The columns on `pithy_auth_users` answer "what is true now"; this table answers "what happened, and who
 * did it".** The two are written together by `../lifecycle/transitions.ts` and never apart. The columns are
 * what enforcement reads on every request, so they hold only the current state; the reason an operator gave
 * for a suspension, and the history of every reinstatement before it, live here.
 *
 * **No foreign key to the user, deliberately.** A purge erases the user row and every row hanging off it, and
 * this table is the one record that must survive it: the trail that the account existed, was deleted, and
 * was erased, by whom and when. A cascade would take the evidence with the subject. So the row names the user
 * by id and holds nothing else about them — no address, no name — and is the only `pithy_auth_*` row a purge
 * leaves behind.
 *
 * Written by the kit through its own Kysely, so its dates take the house ms-epoch `SQLiteDate`.
 */

/** What happened to the account. */
export const UserLifecycleAction = z
  .enum(["suspended", "reinstated", "deleted", "restored", "purge_step", "purged"])
  .describe(
    "The transition: `suspended` and `reinstated`; `deleted` (by an operator, or by the account's owner) and `restored` inside the purge window; `purge_step`, one capability's rows erased during a purge, named in `step`; and `purged`, the erasure finished.",
  );
export type UserLifecycleAction = z.output<typeof UserLifecycleAction>;

/** Who made the transition. */
export const UserLifecycleActorType = z
  .enum(["control-plane", "user", "system"])
  .describe(
    "Who made the transition: `control-plane` (a management client, under a scoped grant), `user` (the account's own holder, deleting their own account), or `system` (the scheduled purge, with nobody calling).",
  );
export type UserLifecycleActorType = z.output<typeof UserLifecycleActorType>;

/** One transition, as stored. */
export const UserLifecycleEvent = z
  .object({
    id: z
      .number()
      .int()
      .describe("Primary key. Auto-incrementing, so a user's history reads in the order it was written."),
    userId: z
      .string()
      .describe(
        "The account this happened to. Not a foreign key: the row outlives the user it names, because a purge must leave its own record behind. Indexed.",
      ),
    action: UserLifecycleAction.describe("What happened to the account."),
    actorType: UserLifecycleActorType.describe("Who made the transition."),
    actorId: z
      .string()
      .nullable()
      .describe(
        "The acting principal's id — the user's own id for a self-service deletion, the connection's for a management client. Null for `system`, and for a management client that named none.",
      ),
    reason: z
      .string()
      .nullable()
      .describe(
        "Why, in the words of whoever made the transition. For a suspension this is the sentence the locked-out person is shown, so it is written for them. Null for a transition nobody had to justify — a purge, a self-service deletion.",
      ),
    suspendedUntil: SQLiteDate.nullable().describe(
      "For a `suspended` row, when that suspension ends by itself; null for one that lasts until a reinstatement, and for every other action. Ms-epoch in SQLite.",
    ),
    step: z
      .string()
      .nullable()
      .describe(
        "For a `purge_step` row, the capability whose rows that step erased — the purge's step name. Null for every other action.",
      ),
    notify: SQLiteBoolean.nullable().describe(
      "For a hard deletion's `deleted` row, whether the purge sends the deletion-complete mail — false when the deletion asked for none. Null for every other row, and for a hard deletion that did not say. The purge reads it, so a purge the daily pass starts keeps the choice (#622).",
    ),
    createdAt: SQLiteDate.describe("When the transition happened. Ms-epoch in SQLite; a `Date` in app code."),
  })
  .describe(
    "One transition in `pithy_auth_user_lifecycle`: an account suspended, reinstated, deleted, restored or purged, with who did it and why.",
  );
export type UserLifecycleEvent = z.output<typeof UserLifecycleEvent>;
