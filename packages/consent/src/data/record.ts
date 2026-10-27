// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConsentMethod } from "@pithy-sh/core/src/consent/purpose";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { pii } from "@pithy-sh/core/src/privacy/classes";
import { encrypted, encryptedTable } from "@pithy-sh/core/src/privacy/encrypted";
import { z } from "zod";
import { ConsentAction, ConsentIdentity, ConsentSubjectKind } from "./enums";

/**
 * One row of `pithy_consent_records`: a grant or a withdrawal, with what proves it. **Append-only**: never updated,
 * never deleted, the account's purge included. The table's triggers refuse both, except a field-key rotation
 * re-sealing the two encrypted names, which changes no fact the row records.
 *
 * The typed name and the representative's name rest encrypted (#390), so the table is declared with
 * `encryptedTable` under the stable name `consent_record`, keyed by the app-assigned `id`.
 */
export const ConsentRecord = encryptedTable(
  z
    .object({
      id: z
        .string()
        .describe(
          "UUID primary key, assigned before the insert, because each encrypted name binds it. Text, so a record cannot be enumerated.",
        ),
      subjectKind: ConsentSubjectKind,
      subjectId: z.string().describe("The user id or the anonymous device id, per `subjectKind`."),
      purpose: z.string().describe("The purpose id this row is about — `email.marketing`."),
      action: ConsentAction,
      noticeVersion: z
        .number()
        .int()
        .describe(
          "The purpose's notice version in force when this row was written. A grant under an older version than the purpose's current one answers no until renewed.",
        ),
      method: ConsentMethod,
      surface: z
        .string()
        .describe(
          "Where the person made the choice, as the adopter names it — `settings`, `banner`, `signup`, `clinic-intake`.",
        ),
      identity: ConsentIdentity,
      documentHash: z
        .string()
        .nullable()
        .describe(
          "The SHA-256, in lowercase hex, of the exact rendered text the person agreed to or withdrew under. The text is kept once per hash in `pithy_consent_documents`, so it can be produced again byte for byte. Null for a click given against no document.",
        ),
      typedName: encrypted(
        pii(z.string().describe("The name the person typed as their signature, for a `typed` grant or withdrawal.")),
      )
        .nullable()
        .describe("The typed signature, sealed at rest. Null for any other method."),
      drawnImageHash: z
        .string()
        .nullable()
        .describe(
          "The SHA-256 of the drawn signature image, stored in the `CONSENT_EVIDENCE` bucket under that hash. Null for any other method.",
        ),
      drawnImageType: z
        .string()
        .nullable()
        .describe("The drawn image's media type — `image/png` or `image/svg+xml`. Null for any other method."),
      provider: z
        .string()
        .nullable()
        .describe(
          "The e-signature provider that completed the envelope, as the adopter's integration names it. Null for any other method.",
        ),
      providerEnvelopeId: z
        .string()
        .nullable()
        .describe("The provider's id for the completed envelope. Null for any other method."),
      providerCertificateHash: z
        .string()
        .nullable()
        .describe(
          "The SHA-256 of the provider's completion certificate, stored in the `CONSENT_EVIDENCE` bucket under that hash. Null when none was supplied.",
        ),
      expiresAt: SQLiteDate.nullable().describe(
        "When the grant stops counting, as a HIPAA authorization must say. Null for a grant with no expiry, and for a withdrawal.",
      ),
      representativeName: encrypted(pii(z.string().describe("The name of the person who signed for the subject.")))
        .nullable()
        .describe(
          "The parent, guardian or personal representative who signed for the subject, sealed at rest. Null when the subject signed for themselves.",
        ),
      representativeRelationship: z
        .string()
        .nullable()
        .describe(
          "How the representative is related to the subject — `parent`, `guardian`. Null with no representative.",
        ),
      recordedAt: SQLiteDate.describe("When the row was written."),
    })
    .describe("One grant or withdrawal of consent in `pithy_consent_records`, with its evidence. Append-only."),
  { name: "consent_record", key: "id" },
);
export type ConsentRecord = z.output<typeof ConsentRecord>;

/** One kept document: the exact rendered text a signed grant was given against, once per content hash. */
export const ConsentDocument = z
  .object({
    hash: z.string().describe("The SHA-256 of the text's UTF-8 bytes, in lowercase hex. The primary key."),
    text: z.string().describe("The exact rendered text the person agreed to, byte for byte."),
    keptAt: SQLiteDate.describe("When this text was first kept."),
  })
  .describe("One signed document in `pithy_consent_documents`, kept once per content hash.");
export type ConsentDocument = z.output<typeof ConsentDocument>;

/** One merge: a visitor's consent carried into the account they signed in as. */
export const ConsentMerge = z
  .object({
    id: z.string().describe("UUID primary key."),
    visitorId: z.string().describe("The anonymous device id that was merged. A visitor merges once."),
    userId: z.string().describe("The account the visitor signed in as."),
    mergedAt: SQLiteDate.describe("When the merge was recorded — at the sign-in that carried the device id."),
  })
  .describe(
    "One merge in `pithy_consent_merges`: a visitor's record carried into an account at sign-in. The visitor's rows are never rewritten; the account's answer reads them through this row.",
  );
export type ConsentMerge = z.output<typeof ConsentMerge>;
