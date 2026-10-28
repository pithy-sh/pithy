// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/** The processing record's closed vocabularies, apart from the walk that fills them, so a browser may import them. */

/** What kind of gap the record names. */
export const PROCESSING_GAP_KINDS = [
  "no-legal-basis",
  "no-consent-purpose",
  "class-not-stored",
  "class-unclaimed",
  "phi-not-covered",
  "no-standing-grant",
] as const;
export type ProcessingGapKindId = (typeof PROCESSING_GAP_KINDS)[number];

/** Where a recipient came from. */
export const RECIPIENT_SOURCES = ["platform", "binding", "declared"] as const;
export type RecipientSource = (typeof RECIPIENT_SOURCES)[number];

/** Where a legal basis came from: the declaring capability, or the `processing` block. */
export const BASIS_SOURCES = ["capability", "config"] as const;
export type BasisSource = (typeof BASIS_SOURCES)[number];

/** The six lawful bases of GDPR Article 6(1), (a) to (f), in that order. */
export const LEGAL_BASES = [
  "consent",
  "contract",
  "legal-obligation",
  "vital-interests",
  "public-task",
  "legitimate-interests",
] as const;

/** One lawful basis for processing. */
export const LegalBasis = z
  .enum(LEGAL_BASES)
  .describe(
    "The lawful basis of GDPR Article 6(1): `consent` (a), `contract` (b), `legal-obligation` (c), `vital-interests` (d), `public-task` (e) or `legitimate-interests` (f). A `consent` basis names the consent purpose it rests on.",
  );
export type LegalBasis = z.infer<typeof LegalBasis>;
