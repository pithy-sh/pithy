import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** The lifecycle of a hold. Terminal states (`released`, `captured`) never change again. */
export const HoldStatus = z
  .enum(["open", "released", "captured"])
  .describe(
    "A hold's state: `open` (funds reserved), `released` (cancelled, funds returned), `captured` (finalized, funds taken).",
  );
export type HoldStatus = z.infer<typeof HoldStatus>;

/**
 * An escrow on a player's funds — the row in `pithy_wallet_holds`. A hold reserves part of a balance (a
 * placed wager) without spending it: the amount moves from `available` to `held` on the account. It later
 * resolves — `release`d back to the player, or `capture`d (spent, e.g. a lost bet). Holds are what make
 * wagering safe: the stake is locked the moment a bet is placed, so it cannot be spent twice while the
 * outcome is pending.
 *
 * `ref` is the hold's stable id and idempotency key; `release`/`capture` reference it.
 */
export const WalletHold = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only; holds are addressed by ref."),
    ref: z
      .string()
      .describe("The caller-supplied idempotency key, unique across holds. Used to release or capture this hold."),
    userId: z.string().describe("The account owner whose funds are held."),
    currency: z.string().describe("The currency code this hold is in."),
    amount: z.number().int().describe("The reserved amount in the currency's minor unit."),
    status: HoldStatus.describe("The hold's current state."),
    createdAt: SQLiteDate.describe("When the hold was placed."),
    resolvedAt: SQLiteDate.nullable().describe("When the hold was released or captured, or null while open."),
  })
  .describe("An escrow on a player's funds — the row in `pithy_wallet_holds`.");
export type WalletHold = z.output<typeof WalletHold>;
export type WalletHoldRow = z.input<typeof WalletHold>;
