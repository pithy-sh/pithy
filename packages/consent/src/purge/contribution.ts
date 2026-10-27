// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import {
  exportRows,
  type PurgeContext,
  purgeBinding,
  type RetainingPurgeContribution,
} from "@pithy-sh/core/src/capability/purge";
import type { FieldKeys } from "@pithy-sh/core/src/crypto/fieldKeys";
import { consentDatabase } from "../data/tables";
import { recordView } from "../http/views";
import { consentStore } from "../record/store";

/**
 * What a person's purge means for `@pithy-sh/consent` (#814): **nothing is erased, and the export says so and
 * why.**
 *
 * The consent record is the proof that processing was allowed while it ran and that it stopped when the person said
 * so. A record that vanished with the account would leave the adopter unable to show either, and a withdrawal is
 * exactly the row that has to outlive the account: it is the evidence processing stopped. So this contribution
 * retains, under its own basis, and the drawn signatures and certificates in R2 are kept with the rows that name
 * them — purged with the record's own retention, never with the account.
 *
 * The export answers with every row the person wrote, the rows of the visitors merged into their account, and the
 * merges, with the typed and representative names opened: they are the person's own words.
 */

/** The one sentence the purge records with this step. */
export const CONSENT_PURGE_SUMMARY = "Keeps every consent the user gave or withdrew, with its evidence.";

/** Why, in the sentence the person is told. */
export const CONSENT_RETENTION_BASIS =
  "Kept as the proof of what you agreed to and when you withdrew it, which the law asks us to be able to show.";

/** The user contribution `consent()` declares. */
export function consentUserPurge(visitorWindowMs: number): RetainingPurgeContribution {
  return {
    subject: "user",
    summary: CONSENT_PURGE_SUMMARY,
    retain: { basis: CONSENT_RETENTION_BASIS },
    export: async (context: PurgeContext) => {
      const d1 = purgeBinding<D1Database>(context.env, "DB", "consent");
      // The catalog is not needed to read rows back; an empty one answers every standing as unknown, which an
      // export never asks.
      const store = consentStore({
        db: consentDatabase(d1),
        keys: context.env.PITHY_FIELD_KEYS as FieldKeys | undefined,
        bucket: undefined,
        purposes: new Map(),
        visitorWindowMs,
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
      });
      const subject = { kind: "account" as const, id: context.subject.id };
      const records = (await store.record(subject)).map(recordView);
      const merges = await Promise.all(
        (await store.mergedVisitors(subject.id)).map((visitor) => store.mergeOf(visitor)),
      );
      return {
        records: exportRows(records),
        merges: exportRows(merges.filter((merge) => merge !== null)),
      };
    },
  };
}
