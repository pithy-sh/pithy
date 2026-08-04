// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SQLiteDate } from "../../data/codecs";

/**
 * One spent control-plane token, as a row.
 *
 * The row's **existence is the whole signal** — a claim is an insert that either wins the primary key or
 * does not. The columns beside `jti` exist for two other jobs: `expiresAt` is what lets the table be
 * pruned rather than grow forever, and `connectionId` is for the incident, not the decision. A replay is
 * refused whatever connection presents it, because the `jti` alone is the key: scoping the uniqueness per
 * connection would let a token captured from one connection be spent again against another, which is
 * exactly the property being bought.
 */
export const ControlPlaneReplay = z
  .object({
    jti: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "The token's unique id, minted by the management client, and the primary key that decides the race. Bounded because it arrives from a caller and becomes a stored key — an unbounded id would be an unbounded write.",
      ),
    connectionId: z
      .string()
      .min(1)
      .describe(
        "The connection whose token claimed this jti. Recorded for forensics only — the claim is decided by the jti alone, so that a token cannot be replayed against a second connection.",
      ),
    expiresAt: SQLiteDate.describe(
      "When this record may be pruned — the instant past which no token carrying this jti could still be accepted. Rows are deleted after it, never before: forgetting a jti while its token is still live is precisely the replay this table exists to stop.",
    ),
  })
  .describe(
    "A spent control-plane token id. Its presence is the refusal; the other columns are for pruning and for the incident.",
  );
export type ControlPlaneReplay = z.output<typeof ControlPlaneReplay>;
