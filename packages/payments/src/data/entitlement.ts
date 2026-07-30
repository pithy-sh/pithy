import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { EntitlementKey } from "@pithy-sh/core/src/entitlement/entitlement";
import { z } from "zod";

/**
 * One entitlement a user holds — the row in `pithy_payments_entitlements`, and the materialized read model
 * `requireEntitlement()` hits. `UNIQUE (userId, entitlement)`: one row per user per key, whichever purchase
 * currently grants it.
 *
 * The row **is** stored (issue #79 decision 5) — resolving entitlements per request from a KV cache or a
 * token claim would make a revocation eventually-consistent, and a revocation must be immediate. What it
 * is never stored *independently of* is the purchase state that produced it: only the projection writes
 * this table, and it re-derives every affected row inside the same transaction as the purchase write.
 *
 * `active` and `expiresAt` are both here, and both matter. The flag is an optimization the projection
 * wrote; the timestamp is the truth. A subscription can lapse with no notification arriving at all, so the
 * read path evaluates `expiresAt` itself rather than trusting the flag — and a read never writes, because
 * repairing a stale row is the reconciliation Workflow's job and the hot path stays a pure read.
 */
export const PaymentsEntitlement = z
  .object({
    id: z
      .string()
      .describe("The row's UUID. Text, like every id payments mints, so nothing about volume is inferable."),
    userId: z.string().describe("The user holding the entitlement."),
    entitlement: EntitlementKey.describe(
      "The entitlement key — what gating code names. `UNIQUE (userId, entitlement)` is what makes this a read model rather than a log.",
    ),
    active: SQLiteBoolean.describe(
      "Whether the granting purchase was in an access-granting status when the projection last wrote this row. An optimization, not the truth — `expiresAt` is rechecked on every read.",
    ),
    expiresAt: SQLiteDate.nullable().describe(
      "When the grant lapses, or null for one that never does. The truth: a read applies it even when `active` still says 1.",
    ),
    sourcePurchaseId: z
      .string()
      .nullable()
      .describe(
        "Provenance — the purchase currently granting this entitlement, or null when nothing does. Answers 'why is this user entitled' without a scan.",
      ),
    manual: SQLiteBoolean.describe(
      "Whether a human wrote this row rather than the projection deriving it. A manual grant is held: the projection skips a row carrying it, so a support comp survives the user's next renewal instead of being erased by it. A revoke clears the hold, handing the key back to the purchases that support it.",
    ),
    createdAt: SQLiteDate.describe("When this entitlement row first appeared for this user."),
    updatedAt: SQLiteDate.describe("When the projection last re-derived it."),
  })
  .describe("One entitlement a user holds — the row in `pithy_payments_entitlements`, the read model gates hit.");
export type PaymentsEntitlement = z.output<typeof PaymentsEntitlement>;
export type PaymentsEntitlementRow = z.input<typeof PaymentsEntitlement>;
