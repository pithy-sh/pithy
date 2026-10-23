// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * `pithy_organization_lifecycle` — every transition an organization went through, who made it, and why (#623).
 *
 * **The four columns on `pithy_organization_organizations` answer "what is true now"; this table answers "what
 * happened, and who did it".** `../lifecycle/transitions.ts` writes the two together, in one `d1.batch()`, and
 * never apart — the shape `@pithy-sh/auth`'s `pithy_auth_user_lifecycle` has, for the same reason.
 *
 * **No foreign key to the organization, deliberately.** A purge erases the organization row and every row hanging
 * off it, and this table is the record that must outlive it: that the organization existed, was deleted and was
 * erased, by whom and when. So the row names the organization by id and holds nothing else about it — no name, no
 * slug — and is the only `pithy_organization_*` row a purge leaves behind.
 */

/** What happened to the organization. */
export const OrganizationLifecycleAction = z
  .enum(["suspended", "reinstated", "deleted", "restored", "purge_step", "purged"])
  .describe(
    "The transition: `suspended` and `reinstated`; `deleted` and `restored` inside the purge window; `purge_step`, one capability's rows erased during a purge, named in `step`; and `purged`, the erasure finished.",
  );
export type OrganizationLifecycleAction = z.output<typeof OrganizationLifecycleAction>;

/** Who made the transition. */
export const OrganizationLifecycleActorType = z
  .enum(["control-plane", "system"])
  .describe(
    "Who made the transition: `control-plane` (a management client, under a scoped grant) or `system` (the scheduled purge, with nobody calling).",
  );
export type OrganizationLifecycleActorType = z.output<typeof OrganizationLifecycleActorType>;

/** One transition, as stored. */
export const OrganizationLifecycleEvent = z
  .object({
    id: z
      .number()
      .int()
      .describe("Primary key. Auto-incrementing, so an organization's history reads in the order it was written."),
    organizationId: z
      .uuid()
      .describe(
        "The organization this happened to. Not a foreign key: the row outlives the organization it names, because a purge must leave its own record behind. Indexed.",
      ),
    action: OrganizationLifecycleAction.describe("What happened to the organization."),
    actorType: OrganizationLifecycleActorType.describe("Who made the transition."),
    actorId: z
      .string()
      .nullable()
      .describe("The management client's verified `sub` — which person acted. Null for `system`."),
    reason: z
      .string()
      .nullable()
      .describe(
        "Why, in the operator's words. For a purge step, the contribution's summary, so the history says what the step erased. Null for a transition nobody had to justify.",
      ),
    suspendedUntil: SQLiteDate.nullable().describe(
      "For a `suspended` row, when that suspension ends by itself; null for one that lasts until a reinstatement, and for every other action.",
    ),
    step: z
      .string()
      .nullable()
      .describe(
        "For a `purge_step` row, the capability whose rows that step erased — the purge's step name. Null for every other action.",
      ),
    createdAt: SQLiteDate.describe("When the transition happened. Ms-epoch in SQLite; a `Date` in app code."),
  })
  .describe(
    "One transition in `pithy_organization_lifecycle`: an organization suspended, reinstated, deleted, restored or purged, with who did it and why.",
  );
export type OrganizationLifecycleEvent = z.output<typeof OrganizationLifecycleEvent>;
