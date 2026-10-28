// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ProcessingActivityInput } from "@pithy-sh/core/src/processing/activity";

/** What auth does with personal data: it keeps accounts and signs their holders in. */
export const AUTH_PROCESSING: readonly ProcessingActivityInput[] = [
  {
    id: "auth.account",
    purpose: "Keep a person's account, sign them in, and keep the sessions that prove it.",
    classes: ["pii"],
    legalBasis: "contract",
  },
];
