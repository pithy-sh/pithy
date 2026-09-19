// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { LedgerPeer } from "@pithy-sh/ledger/src/peer";

/**
 * A ledger operation a game model asks the session to perform — the wager seam.
 *
 * A model's `apply`/`resolve` are pure: they cannot touch a database. So instead of moving money
 * themselves, they *declare* the movements as effects, and the Durable Object settles them through
 * `@pithy-sh/ledger` after the transition. That keeps the model deterministic (a requirement for
 * replay and provable fairness) while still letting a game hold a stake, capture a loss, or pay a win.
 *
 * Every effect carries a `ref` — the ledger's idempotency key. Because a model is deterministic, a replayed
 * transition re-emits effects with the *same* refs, so applying them twice is a no-op: a payout pays once.
 * Build refs stably from `ctx.sessionId` and the game's own state (`${sessionId}:round-3:alice:stake`).
 */
export type LedgerEffect =
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
 * Settle a model's declared effects through the ledger the composition handed over. `@pithy-sh/ledger` is an
 * *optional* peer, reached only when a game actually emits effects — a game with no wagering never touches it.
 * Never imported: `session/peers.ts` says why, and a deployment without the ledger has nothing to resolve.
 * Applied **before** the DO commits the new game state (see the DO): a hold that a player cannot cover throws
 * here, so the wagering action is rejected and the state never advances — and so does a wager with no ledger
 * composed to hold it, rather than a session that plays for stakes nobody recorded.
 */
export async function applyLedgerEffects(
  d1: D1Database,
  effects: readonly LedgerEffect[],
  peer: LedgerPeer | undefined,
): Promise<void> {
  if (effects.length === 0) return;
  if (peer === undefined) {
    throw new InternalError({
      message: "This game moves a balance, and no ledger is composed.",
      action: "Add `ledger(...)` to this Worker's capabilities in pithy.config.ts, or play the game without stakes.",
      detail: `A game model emitted ${effects.length} ledger effect(s) and multiplayer() found no ledger among the composed capabilities.`,
    });
  }
  const ledger = peer.openLedger(d1);
  for (const effect of effects) {
    switch (effect.op) {
      case "credit":
        await ledger.credit(effect.userId, effect.currency, effect.amount, effect.ref, { memo: effect.memo });
        break;
      case "debit":
        await ledger.debit(effect.userId, effect.currency, effect.amount, effect.ref, { memo: effect.memo });
        break;
      case "hold":
        await ledger.hold(effect.userId, effect.currency, effect.amount, effect.ref);
        break;
      case "release":
        await ledger.release(effect.ref);
        break;
      case "capture":
        await ledger.capture(effect.ref, { amount: effect.amount, memo: effect.memo });
        break;
      case "transfer":
        await ledger.transfer(effect.from, effect.to, effect.currency, effect.amount, effect.ref, {
          memo: effect.memo,
        });
        break;
    }
  }
}
