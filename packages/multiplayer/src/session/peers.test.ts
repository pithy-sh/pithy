// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { ledger } from "@pithy-sh/ledger/src/capability";
import { describe, expect, test } from "vitest";
import { type MultiplayerOptions, multiplayer } from "../capability";
import { multiplayerPeers } from "./peers";

/**
 * **A peer the configured games use is refused at assembly when this Worker cannot reach it** (#645 review).
 *
 * Reproduced before the fix: a pre-#645 ledger read as absent, so a bet threw "no ledger is composed" beside a
 * composed ledger; a leaderboard composed in another Worker, or too old, lost every result to a log line. The
 * session runs in this Worker's Durable Object and reaches only what this Worker composes, so the compose hook
 * is where each of those is decided — by name, before a session exists.
 */

const TIC_TAC_TOE = { key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } };
const PUBLISHING = {
  ...TIC_TAC_TOE,
  key: "ranked",
  leaderboard: { board: "wins", points: { win: 1, draw: 0, loss: 0 } },
};
const CRAPS = { key: "craps", kind: "craps", mode: "table" as const, players: 6, rules: { currency: "chips" } };

/** A pre-#645 release: the capability's name and config field, and no peer surface. */
const OLD_LEDGER = { name: "ledger", ledgerConfig: { currencies: [{ code: "chips" }] } } as unknown as Capability;
const OLD_BOARD = { name: "leaderboard", leaderboardConfig: { boards: [] } } as unknown as Capability;

const LEDGER = ledger({ currencies: [{ code: "chips", name: "Chips" }] });
const BOARD = leaderboard({ boards: [{ key: "wins", direction: "desc", aggregation: "sum" }] });

/** Assemble one Worker: every capability's `compose` over the whole set, as `createEntrypoint` does. */
function assemble(options: MultiplayerOptions, siblings: Capability[]): unknown {
  const composed = [...siblings, multiplayer(options)];
  try {
    for (const capability of composed) capability.compose?.({ capabilities: composed });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The client-safe half of a refusal. */
function said(error: unknown): { message: string; action?: string; detail?: string } {
  expect(error).toBeInstanceOf(PithyError);
  return (error as PithyError).payload;
}

describe("the ledger a wagering game settles through", () => {
  test("a wagering game with no ledger in this Worker is refused, naming the game and the fix", () => {
    const refusal = said(assemble({ games: [CRAPS] }, []));
    expect(refusal.message).toBe('No ledger is composed in this Worker, and game "craps" moves balances through one.');
    expect(refusal.action).toBe(
      'Compose `ledger(...)` in this Worker, or turn wagering off by removing game "craps" from `games`.',
    );
    expect(refusal.detail).toContain("craps (craps)");
  });

  test("a ledger too old to carry its surface is refused, whatever the games are", () => {
    for (const games of [[CRAPS], [TIC_TAC_TOE]]) {
      const refusal = said(assemble({ games }, [OLD_LEDGER]));
      expect(refusal.message).toBe("The composed ledger is too old for multiplayer to settle a wager.");
      expect(refusal.action).toBe("Upgrade @pithy-sh/ledger to the version this @pithy-sh/multiplayer peers.");
    }
  });

  test("a wagering game beside a current ledger composes, and the session is handed it", () => {
    expect(assemble({ games: [CRAPS] }, [LEDGER])).toBeUndefined();
    expect(multiplayerPeers().ledger).toBe(LEDGER.ledgerPeer);
  });
});

describe("the leaderboard a game publishes to", () => {
  test("a game with a leaderboard block and no leaderboard in this Worker is refused, naming game and board", () => {
    const error = assemble({ games: [PUBLISHING] }, []);
    expect(said(error).message).toBe(
      'No leaderboard is composed in this Worker, and game "ranked" publishes its results to one.',
    );
    expect(said(error).action).toBe(
      'Compose `leaderboard(...)` in this Worker, or turn publishing off by removing the `leaderboard` block from game "ranked".',
    );
    expect(said(error).detail).toContain('ranked (board "wins")');
  });

  test("a leaderboard too old to carry its surface is refused", () => {
    expect(said(assemble({ games: [PUBLISHING] }, [OLD_BOARD])).message).toBe(
      "The composed leaderboard is too old for multiplayer to publish a result.",
    );
  });

  test("a publishing game beside a current leaderboard composes, and the session is handed it", () => {
    expect(assemble({ games: [PUBLISHING] }, [BOARD])).toBeUndefined();
    expect(multiplayerPeers().leaderboard).toBe(BOARD.leaderboardPeer);
  });
});

describe("a game set that uses neither peer", () => {
  test("composes with neither, and the session is handed nothing", () => {
    expect(assemble({ games: [TIC_TAC_TOE] }, [])).toBeUndefined();
    expect(multiplayerPeers()).toEqual({});
  });
});
