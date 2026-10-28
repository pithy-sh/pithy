// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConsentMethod, ConsentPurposeId } from "@pithy-sh/core/src/consent/purpose";
import { z } from "zod";
import { ConsentIdentity, ConsentSubjectKind } from "../data/enums";

/**
 * The consent capability's request schemas — every input surface's contract (CLAUDE.md §HTTP). Bounded throughout:
 * a signature image, a certificate and a document are the only large values, and each has a ceiling.
 */

/** The ceiling on a rendered document's text: 256 KiB of characters. */
export const MAX_DOCUMENT_LENGTH = 262_144;

/** The ceiling on a base64 drawn signature: 512 KiB of base64, about 384 KiB of image. */
export const MAX_DRAWN_LENGTH = 524_288;

/** The ceiling on a base64 provider certificate: 2 MiB of base64. */
export const MAX_CERTIFICATE_LENGTH = 2_097_152;

/** A lowercase SHA-256 in hex. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "A SHA-256 in lowercase hex.")
  .describe("A SHA-256 content hash in lowercase hex.");

/** A drawn signature, as the client captured it. */
export const DrawnSignature = z
  .object({
    image: z
      .string()
      .min(1)
      .max(MAX_DRAWN_LENGTH)
      .describe("The drawn signature as standard base64 — a PNG, or an SVG's UTF-8 bytes."),
    type: z.enum(["image/png", "image/svg+xml"]).describe("The image's media type."),
  })
  .describe("A drawn signature, for the `drawn` method.");

/** A provider's completed envelope, as the adopter's own integration supplies it. */
export const ProviderEnvelope = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .describe("The e-signature provider, as your integration names it — `docusign`, `dropbox-sign`."),
    envelopeId: z.string().min(1).max(256).describe("The provider's id for the completed envelope."),
    certificate: z
      .string()
      .min(1)
      .max(MAX_CERTIFICATE_LENGTH)
      .optional()
      .describe("The provider's completion certificate as standard base64, usually a PDF. Kept in R2 by hash."),
  })
  .describe("An e-signature provider's completed envelope, for the `provider` method.");

/** Someone signing for the subject. */
export const Representative = z
  .object({
    name: z.string().min(1).max(256).describe("The representative's name. Encrypted at rest."),
    relationship: z
      .string()
      .min(1)
      .max(64)
      .describe("How they are related to the subject — `parent`, `guardian`, `personal representative`."),
  })
  .describe("A parent, guardian or personal representative signing for the subject.");

/** What every grant or withdrawal carries. */
const ChoiceFields = {
  purpose: ConsentPurposeId,
  method: ConsentMethod,
  surface: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_.-]*$/, "A short lowercase name.")
    .describe("Where the person made the choice — `settings`, `banner`, `signup`. A short lowercase name."),
  identity: ConsentIdentity.optional().describe(
    "How the person's identity was verified, as your flow declares it. Defaults to `session` for a signed-in account and `none` for a visitor; a visitor cannot claim `session`.",
  ),
  document: z
    .string()
    .min(1)
    .max(MAX_DOCUMENT_LENGTH)
    .optional()
    .describe(
      "The exact rendered text the person saw. Required for a signed grant (any method but `click`), and kept once per content hash so it can be produced again byte for byte. A `click` records its hash and keeps no text.",
    ),
  typedName: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("The name the person typed, for the `typed` method. Encrypted at rest."),
  drawn: DrawnSignature.optional().describe("The drawn signature, for the `drawn` method."),
  provider: ProviderEnvelope.optional().describe("The provider's completed envelope, for the `provider` method."),
};

/** `POST {basePath}/grants`. */
export const GrantBody = z
  .object({
    ...ChoiceFields,
    noticeVersion: z
      .number()
      .int()
      .positive()
      .describe("The notice version the person was shown. It must be the purpose's current one."),
    expiresAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("When the grant stops counting, as an ISO-8601 instant in the future. Omit for no expiry."),
    representative: Representative.optional().describe("Who signed for the subject, when it was not the subject."),
  })
  .describe("Give consent to one purpose.");
export type GrantBody = z.output<typeof GrantBody>;

/** `POST {basePath}/withdrawals`. */
export const WithdrawBody = z
  .object({ ...ChoiceFields })
  .describe(
    "Withdraw consent from one purpose. A click withdraws, unless the purpose requires a written withdrawal at the grade of the grant.",
  );
export type WithdrawBody = z.output<typeof WithdrawBody>;

/** A document or evidence object, by hash. */
export const HashParams = z.object({ hash: Sha256Hex }).describe("A content hash in the path.");

/** A subject on the control plane. */
export const SubjectParams = z
  .object({
    kind: ConsentSubjectKind,
    subjectId: z.string().min(1).max(256).describe("The user id or the anonymous device id."),
  })
  .describe("A consent subject in the path: its kind, and its id in that kind.");
