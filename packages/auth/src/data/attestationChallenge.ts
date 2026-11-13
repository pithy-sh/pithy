// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * `pithy_auth_attestation_challenges`: a challenge the challenge route issued and nobody has presented yet.
 *
 * Keyed by the challenge's SHA-256, so a read of the table hands nobody a usable challenge. A row is deleted
 * when its challenge is presented, pass or fail, which is what makes a challenge single-use, and issuing deletes
 * the rows that ran out unpresented (`../attestation/challenge.ts`). It names no person and no device.
 */
export const AttestationChallenge = z
  .object({
    id: z
      .string()
      .describe("Primary key: the unpadded base64url SHA-256 of the challenge. The challenge itself is never stored."),
    issuedAt: SQLiteDate.describe("When the challenge was issued. Ms-epoch in SQLite."),
    expiresAt: SQLiteDate.describe("When the challenge stops being accepted. Ms-epoch in SQLite. Indexed."),
  })
  .describe("An issued, unpresented attestation challenge in `pithy_auth_attestation_challenges`.");
export type AttestationChallenge = z.output<typeof AttestationChallenge>;
