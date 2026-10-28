// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The consent capability's response schemas — what every route answers, as runtime values a client validates
 * against (CLAUDE.md §HTTP). Dates cross as ISO-8601 strings; nothing here carries a codec. Plain enums rather than
 * imports of the row's, so a browser program that reads these pulls in no table.
 */

const Method = z.enum(["click", "typed", "drawn", "provider"]).describe("How the consent was given or withdrawn.");
const SubjectKind = z.enum(["account", "visitor"]).describe("Whose consent: an account, or an anonymous visitor.");

/** One purpose, as the person and a client see it. */
export const ConsentPurposeView = z
  .object({
    id: z.string().describe("The purpose id — `email.marketing`."),
    summary: z.string().describe("What agreeing allows, written for the person."),
    noticeVersion: z.number().int().describe("The current notice version. A grant names it."),
    classes: z.array(z.string()).describe("The data classes the purpose covers."),
    explicit: z.boolean().describe("Whether the purpose needs explicit consent (GDPR Article 9)."),
    minimumMethod: Method.describe("The weakest method a grant may be given by."),
    writtenWithdrawal: z
      .boolean()
      .describe("Whether a withdrawal must be made at least at the grade of the grant it withdraws."),
  })
  .describe("One purpose processed under consent.");
export type ConsentPurposeView = z.output<typeof ConsentPurposeView>;

/** `GET {basePath}/purposes`. */
export const ConsentPurposesResponse = z
  .object({ purposes: z.array(ConsentPurposeView).describe("Every purpose this Worker asks consent for.") })
  .describe("The purposes this Worker asks consent for.");
export type ConsentPurposesResponse = z.output<typeof ConsentPurposesResponse>;

/** Why a subject does or does not hold consent to a purpose. */
export const ConsentStandingView = z
  .enum([
    "granted",
    "never_granted",
    "withdrawn",
    "expired",
    "stale_notice",
    "below_minimum",
    "visitor_expired",
    "unknown_purpose",
  ])
  .describe(
    "Where the subject stands on a purpose: `granted`, or why not — never granted, withdrawn, expired, granted under an older notice, granted below the purpose's minimum method, a visitor's grant past the anonymous window, or a purpose no longer declared.",
  );

/** The subject a record belongs to. */
export const ConsentSubjectView = z
  .object({
    kind: SubjectKind,
    id: z.string().describe("The user id, or the anonymous device id."),
  })
  .describe("Whose consent this is.");

/** Someone who signed for the subject. */
export const ConsentRepresentativeView = z
  .object({
    name: z.string().describe("The representative's name."),
    relationship: z.string().describe("How they are related to the subject."),
  })
  .describe("A parent, guardian or personal representative who signed for the subject.");

/** One grant or withdrawal, with its evidence. */
export const ConsentRecordView = z
  .object({
    id: z.string().describe("The record's id."),
    subject: ConsentSubjectView,
    purpose: z.string().describe("The purpose id."),
    action: z.enum(["grant", "withdraw"]).describe("Whether this gave consent or withdrew it."),
    noticeVersion: z.number().int().describe("The notice version in force when it was recorded."),
    method: Method,
    surface: z.string().describe("Where the choice was made."),
    identity: z
      .enum(["none", "session", "verified_email", "in_person", "provider"])
      .describe("How the person's identity was verified."),
    documentHash: z.string().nullable().describe("The SHA-256 of the exact document agreed to, or null."),
    typedName: z.string().nullable().describe("The typed signature, for `typed`; null otherwise."),
    drawnImageHash: z
      .string()
      .nullable()
      .describe("The SHA-256 of the drawn signature, kept in R2 under it; null otherwise."),
    drawnImageType: z.string().nullable().describe("The drawn image's media type; null otherwise."),
    provider: z.string().nullable().describe("The e-signature provider, for `provider`; null otherwise."),
    providerEnvelopeId: z.string().nullable().describe("The provider's envelope id; null otherwise."),
    providerCertificateHash: z
      .string()
      .nullable()
      .describe("The SHA-256 of the provider's completion certificate, kept in R2 under it; null when none."),
    expiresAt: z.string().nullable().describe("When the grant stops counting, ISO-8601; null for no expiry."),
    representative: ConsentRepresentativeView.nullable().describe("Who signed for the subject, or null."),
    recordedAt: z.string().describe("When it was recorded, ISO-8601."),
  })
  .describe("One grant or withdrawal in the append-only consent record.");
export type ConsentRecordView = z.output<typeof ConsentRecordView>;

/** Where a subject stands on one purpose. */
export const ConsentPurposeStandingView = z
  .object({
    purpose: ConsentPurposeView,
    standing: ConsentStandingView,
    granted: z.boolean().describe("Whether `hasConsent` answers yes for this purpose now."),
  })
  .describe("Where a subject stands on one purpose.");

/** `GET {basePath}/me`. */
export const MyConsentResponse = z
  .object({
    subject: ConsentSubjectView.nullable().describe(
      "Who is asking: the signed-in account, or the visitor whose device id cookie came with the request. Null for a visitor who has not chosen yet.",
    ),
    purposes: z.array(ConsentPurposeStandingView).describe("Every purpose, and where this subject stands on it."),
    records: z.array(ConsentRecordView).describe("Every grant and withdrawal this subject made, oldest first."),
  })
  .describe("The caller's own consents: where they stand, and the record behind it.");
export type MyConsentResponse = z.output<typeof MyConsentResponse>;

/** `POST {basePath}/grants` and `POST {basePath}/withdrawals`. */
export const ConsentChoiceResponse = z
  .object({
    record: ConsentRecordView,
    standing: ConsentStandingView,
    granted: z.boolean().describe("Whether `hasConsent` answers yes for this purpose now."),
  })
  .describe("The row the choice appended, and where the subject now stands.");
export type ConsentChoiceResponse = z.output<typeof ConsentChoiceResponse>;

/** One notice version's counts. */
export const ConsentVersionCountView = z
  .object({
    noticeVersion: z.number().int().describe("The notice version."),
    grants: z.number().int().describe("Subjects whose latest row is a grant under this version."),
    withdrawals: z.number().int().describe("Subjects whose latest row is a withdrawal under this version."),
  })
  .describe("Counts under one notice version.");

/** `GET {basePath}/control-plane/purposes`. */
export const ConsentAdminPurposesResponse = z
  .object({
    purposes: z
      .array(
        z
          .object({
            purpose: ConsentPurposeView,
            versions: z
              .array(ConsentVersionCountView)
              .describe("Counts per notice version, oldest first. A version nobody answered is absent."),
          })
          .describe("One purpose and its counts."),
      )
      .describe("Every declared purpose, with counts per notice version."),
  })
  .describe("Counts of current grants and withdrawals, per purpose and notice version.");
export type ConsentAdminPurposesResponse = z.output<typeof ConsentAdminPurposesResponse>;

/** One merge. */
export const ConsentMergeView = z
  .object({
    visitorId: z.string().describe("The anonymous device id that was merged."),
    userId: z.string().describe("The account it was merged into."),
    mergedAt: z.string().describe("When, ISO-8601."),
  })
  .describe("A visitor's consent carried into an account at sign-in.");
export type ConsentMergeView = z.output<typeof ConsentMergeView>;

/** `GET {basePath}/control-plane/subjects/:kind/:subjectId`. */
export const ConsentAdminSubjectResponse = z
  .object({
    subject: ConsentSubjectView,
    purposes: z.array(ConsentPurposeStandingView).describe("Every purpose, and where this subject stands on it."),
    records: z
      .array(ConsentRecordView)
      .describe("Every row about this subject, and for an account every row of the visitors merged into it."),
    merges: z
      .array(ConsentMergeView)
      .describe("The visitors merged into this account, or the account this visitor was merged into."),
  })
  .describe("One subject's consent record.");
export type ConsentAdminSubjectResponse = z.output<typeof ConsentAdminSubjectResponse>;
