// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ProcessingActivityInput } from "@pithy-sh/core/src/processing/activity";

/**
 * What consent does with personal data: it keeps the record of every grant and withdrawal, typed and signed names
 * included, because a controller must be able to show consent was given (GDPR Article 7(1)).
 */
export const CONSENT_PROCESSING: readonly ProcessingActivityInput[] = [
  {
    id: "consent.record",
    purpose: "Keep the record of every consent given and withdrawn, as proof the processing it allowed was allowed.",
    classes: ["pii"],
    legalBasis: "legal-obligation",
  },
];
