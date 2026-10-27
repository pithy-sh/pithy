// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { exportRows, purgeBinding, type RetainingPurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { EmailEvent } from "../data/emailEvent";
import { EmailJob } from "../data/emailJob";
import { EmailSuppression } from "../data/emailSuppression";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";

/**
 * What a person's purge means for `@pithy-sh/email` (#814): **nothing is erased, and the export says so and why.**
 *
 * A suppression has to outlive the person. It is the record that an address bounced, complained or asked not to be
 * mailed, and the list is checked before every send: erase the row and the next send — a newsletter to an address
 * that unsubscribed — goes out, because nothing remembers that it should not. So this contribution **retains**, and
 * the log of mail sent to the address stays beside it as the delivery record a bounce or a complaint is read
 * against. The purge records the step as retained with the basis below, and erases no row.
 *
 * **Found by address.** Email stores no user id: the suppression list and the log are keyed by the address, in
 * `normalizeAddress`'s form. The step reads the account's address (`PurgeContext.address`); with none to read there
 * is nothing to find.
 *
 * **Never a message's payload, and never a tracked link.** A job's payload is the template's variables, and a sign-in
 * mail's variables are the link that signs the person in; a click event's URL can be that link. The export carries
 * what was sent, when and how it went, and leaves both out.
 */

/** The one sentence the purge records with this step. */
export const EMAIL_PURGE_SUMMARY = "Keeps the user's address on the suppression list, and the log of mail sent to it.";

/** Why, in the sentence the person is told. */
export const EMAIL_RETENTION_BASIS =
  "Kept so your unsubscribe holds: the address stays on the list of addresses not to mail, with the record of what was sent to it.";

/** The user contribution `email()` declares, over its two D1 bindings. */
export function emailUserPurge(database = "DB", suppressions = "EMAIL_SUPPRESSIONS"): RetainingPurgeContribution {
  return {
    subject: "user",
    summary: EMAIL_PURGE_SUMMARY,
    retain: { basis: EMAIL_RETENTION_BASIS },
    export: async (context) => {
      const read = await context.address?.();
      if (!read) return { suppressions: [], jobs: [], events: [] };
      const address = normalizeAddress(read);
      const log = emailDatabase(purgeBinding<D1Database>(context.env, database, "email"));
      const list = emailSuppressionDatabase(purgeBinding<D1Database>(context.env, suppressions, "email"));
      const [suppressed, jobs, events] = await Promise.all([
        list.selectFrom("pithyEmailSuppressions").selectAll().where("email", "=", address).execute(),
        log
          .selectFrom("pithyEmailJobs")
          .selectAll()
          .where("recipientKey", "=", address)
          .orderBy("createdAt")
          .orderBy("id")
          .execute(),
        log
          .selectFrom("pithyEmailEvents")
          .selectAll()
          .where("recipient", "=", address)
          .orderBy("createdAt")
          .orderBy("id")
          .execute(),
      ]);
      return {
        suppressions: exportRows(suppressed.map((row) => EmailSuppression.parse(row))),
        jobs: exportRows(
          jobs.map((row) => {
            const { payload: _variables, ...job } = EmailJob.parse(row);
            return job;
          }),
        ),
        events: exportRows(
          events.map((row) => {
            const { linkUrl: _link, ...event } = EmailEvent.parse(row);
            return event;
          }),
        ),
      };
    },
  };
}
