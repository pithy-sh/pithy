import type { D1Database } from "@cloudflare/workers-types";

/**
 * A wallet operation a game model asks the session to perform — the wager seam.
 *
 * A model's `apply`/`resolve` are pure: they cannot touch a database. So instead of moving money
 * themselves, they *declare* the movements as effects, and the Durable Object settles them through
 * `@pithy-sh/wallet`'s ledger after the transition. That keeps the model deterministic (a requirement for
 * replay and provable fairness) while still letting a game hold a stake, capture a loss, or pay a win.
 *
 * Every effect carries a `ref` — the ledger's idempotency key. Because a model is deterministic, a replayed
 * transition re-emits effects with the *same* refs, so applying them twice is a no-op: a payout pays once.
 * Build refs stably from `ctx.sessionId` and the game's own state (`${sessionId}:round-3:alice:stake`).
 */
export type WalletEffect =
  | {
      readonly op: "credit";
      readonly userId: string;
      readonly currency: string;
      readonly amount: number;
      readonly ref: string;
      readonly memo?: string;
    }
  | {
      readonly op: "debit";
      readonly userId: string;
      readonly currency: string;
      readonly amount: number;
      readonly ref: string;
      readonly memo?: string;
    }
  | {
      readonly op: "hold";
      readonly userId: string;
      readonly currency: string;
      readonly amount: number;
      readonly ref: string;
    }
  | { readonly op: "release"; readonly ref: string }
  | { readonly op: "capture"; readonly ref: string; readonly amount?: number; readonly memo?: string }
  | {
      readonly op: "transfer";
      readonly from: string;
      readonly to: string;
      readonly currency: string;
      readonly amount: number;
      readonly ref: string;
      readonly memo?: string;
    };

/**
 * Settle a model's wallet effects through the ledger. `@pithy-sh/wallet` is an *optional* peer, loaded by
 * dynamic import only when a game actually emits effects — a game with no wagering never touches it, and a
 * deployment without wallet never resolves the import. Applied **before** the DO commits the new game state
 * (see the DO): a hold that a player cannot cover throws here, so the wagering action is rejected and the
 * state never advances.
 */
export async function applyWalletEffects(d1: D1Database, effects: readonly WalletEffect[]): Promise<void> {
  if (effects.length === 0) return;
  const { ledger } = await import("@pithy-sh/wallet/src/ledger/ledger");
  const w = ledger(d1);
  for (const effect of effects) {
    switch (effect.op) {
      case "credit":
        await w.credit(effect.userId, effect.currency, effect.amount, effect.ref, { memo: effect.memo });
        break;
      case "debit":
        await w.debit(effect.userId, effect.currency, effect.amount, effect.ref, { memo: effect.memo });
        break;
      case "hold":
        await w.hold(effect.userId, effect.currency, effect.amount, effect.ref);
        break;
      case "release":
        await w.release(effect.ref);
        break;
      case "capture":
        await w.capture(effect.ref, { amount: effect.amount, memo: effect.memo });
        break;
      case "transfer":
        await w.transfer(effect.from, effect.to, effect.currency, effect.amount, effect.ref, { memo: effect.memo });
        break;
    }
  }
}
