// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `pithy_organization_acting` table — which organization one session is acting in.
 *
 * A person may belong to several organizations and acts in exactly one at a time. That answer has to
 * live somewhere, and where it lives decides how it can be got wrong.
 *
 * **Not the URL.** A slug in the path means a member of two accounts addresses either by typing a
 * different address, and the screen can no longer be trusted to say what is in force. A URL that cannot
 * name another tenant cannot be pointed at one.
 *
 * **Not the client.** A preference the browser sends is a preference the browser can change, and this
 * one decides which tenant's data a request may reach.
 *
 * **Not a claim on the session.** A role or an organization written into a token is a fact frozen at
 * sign-in, and revoking a membership would then wait for the token to expire.
 *
 * So: a row of this capability's own, keyed by the session.
 *
 * **Keyed by the session, not the user.** The choice is session state. Signing out must take it with
 * it, two browsers must be able to look at two different accounts, and nothing here should outlive the
 * credential that made it. A column on a user row would be a preference that follows a person between
 * devices, which is a different thing wearing the same shape.
 *
 * **The user is on the row as well as the session id**, so a read matches both halves in one predicate.
 * And the row is never the authority on its own: every read rejoins the memberships table, so a
 * selection no longer backed by a membership grants nothing — and is treated as *no selection* rather
 * than as a refusal, because the caller may still belong somewhere else.
 *
 * **`chosen` is the half a single nullable column cannot express.** Somebody with one membership is put
 * into it without being asked; somebody with three picked. Both end up with a row here, and a chooser
 * has to be able to tell them apart — to offer "switch account" to one and not to the other, and to
 * know whether landing somewhere was a decision or a default.
 */
export const ActingOrganization = z
  .object({
    sessionId: z
      .string()
      .min(1)
      .describe(
        "Primary key. The session this choice belongs to — `@pithy-sh/auth`'s session id, as `c.var.auth.sessionId` carries it.",
      ),
    userId: z
      .string()
      .min(1)
      .describe(
        "The person the session belongs to. References `pithy_auth_users(id)`. Read alongside the session id so a row can never answer for somebody else.",
      ),
    organizationId: z
      .uuid()
      .describe(
        "The organization in force. Foreign key to `pithy_organization_organizations(id)` — an account that is deleted takes every selection of it with it rather than leaving sessions pointed at nothing.",
      ),
    chosen: SQLiteBoolean.describe(
      "Whether somebody picked this, as against being put into the only account they have. What a chooser keys on, and the distinction a single `activeOrganizationId` column cannot carry.",
    ),
    chosenAt: SQLiteDate.describe(
      "When it was last set. Ms-epoch in SQLite; a `Date` in app code. Kept so a support question about what somebody was looking at has an answer.",
    ),
  })
  .describe(
    "One session's acting organization, in `pithy_organization_acting`. Never authority on its own — every read rejoins memberships, so revoking a membership revokes the selection in the same statement.",
  );
export type ActingOrganization = z.output<typeof ActingOrganization>;
export type ActingOrganizationRow = z.input<typeof ActingOrganization>;
