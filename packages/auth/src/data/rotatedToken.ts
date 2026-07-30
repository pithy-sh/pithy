// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * `pithy_auth_rotated_tokens` — the reuse-detection ledger, a Pithy-specific table with no
 * Better-Auth equivalent.
 *
 * One row per refresh token that has been consumed by a rotation. On `/auth/token/rotate` the
 * presented session token is deleted and recorded here; presenting it again (after it no longer
 * resolves to a live session) is a replayed refresh credential — the canonical compromise signal for
 * rotated refresh tokens (OAuth refresh rotation, RFC 6819 §5.2.2.3). The row carries the `familyId`
 * so the whole token family can be revoked on reuse. Written by Pithy code through our shared Kysely,
 * so it keeps Pithy's house ms-epoch `SQLiteDate` — unlike the Better-Auth tables.
 */
export const RotatedToken = z
  .object({
    token: z
      .string()
      .describe(
        "Primary key. The consumed session token, recorded when a rotation revoked it. Presenting it again is reuse.",
      ),
    familyId: z
      .string()
      .describe(
        "The refresh-token family this token belonged to. The unit revoked when reuse is detected — every session sharing it is signed out. Indexed.",
      ),
    userId: z
      .string()
      .describe("The owning user's id, for attributing the reuse audit event to the compromised account."),
    rotatedAt: SQLiteDate.describe(
      "When the token was consumed by a rotation. Ms-epoch in SQLite; a `Date` in app code. Drives retention pruning.",
    ),
  })
  .describe(
    "A consumed refresh token in `pithy_auth_rotated_tokens` — the ledger that powers refresh-token reuse detection and family revocation.",
  );
export type RotatedToken = z.output<typeof RotatedToken>;
