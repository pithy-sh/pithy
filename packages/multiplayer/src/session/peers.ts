// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { LeaderboardPeer } from "@pithy-sh/leaderboard/src/peer";
import type { LedgerPeer } from "@pithy-sh/ledger/src/peer";
import type { ResolvedGame } from "../config/config";
import { resolveModel } from "../game/model";

/**
 * **The optional peers a session reaches, as the composition handed them over** (#645).
 *
 * A session settles wagers through `@pithy-sh/ledger` and publishes results to `@pithy-sh/leaderboard`, and
 * both are optional: a game with no stakes never touches the ledger, a game with no board never touches the
 * leaderboard. Both used to be reached by `import()` inside a `try`, which is optional at runtime and required
 * at bundle time — wrangler's esbuild resolves a literal specifier whether or not the branch holding it ever
 * runs, so a project without either package could not bundle the session at all.
 *
 * So they arrive from the composition. `multiplayer()`'s `compose` hook finds each peer's surface among the
 * composed capabilities and records it here; the session reads it. Module state, because the Durable Object is
 * constructed by the runtime rather than by the factory, and it shares the isolate the Worker entry composed
 * in — the same reason the game-model registry beside it is module state. Only types name the two packages,
 * and a bundler never sees a type.
 *
 * **Nothing degrades silently (#645 review).** A peer the configured games use, missing from this Worker, is
 * refused here at assembly: a game with a `leaderboard` block and no leaderboard composed lost every result, and
 * a wagering game with no ledger threw at the first bet with a message about the wrong thing. "Composed in
 * another Worker" is the same refusal, because the session runs here and can only reach what is composed here.
 * And a peer that *is* composed but was released before its surface existed is refused whatever the games say —
 * read as absent, it is the same silence with a more confusing cause.
 */
export interface MultiplayerPeers {
  /** `ledger()`'s surface, when it is composed. */
  readonly ledger?: LedgerPeer;
  /** `leaderboard()`'s surface, when it is composed. */
  readonly leaderboard?: LeaderboardPeer;
}

let composed: MultiplayerPeers = {};

/** One optional peer as the composition holds it: not composed, composed and too old, or its surface. */
type Found<T> =
  | { readonly state: "absent" }
  | { readonly state: "old" }
  | { readonly state: "present"; readonly peer: T };

/**
 * The named kit capability's peer surface. The capability is recognized by the config field it has always
 * carried, not by the surface — a release from before #645 has the one and not the other, and that is the case
 * this must tell apart from absence.
 */
function find<T>(
  capabilities: readonly Capability[],
  name: string,
  config: string,
  key: string,
  probe: string,
): Found<T> {
  const capability = capabilities.find((candidate) => candidate.name === name && config in candidate);
  if (capability === undefined) return { state: "absent" };
  const peer = (capability as unknown as Record<string, Record<string, unknown> | undefined>)[key];
  if (typeof peer?.[probe] !== "function") return { state: "old" };
  return { state: "present", peer: peer as T };
}

/** The refusal for a composed peer released before its surface. */
function tooOld(pkg: string, key: string, wants: string): ValidationError {
  return new ValidationError({
    message: `Multiplayer ${wants} through ${pkg}, and the composed one is too old to be reached.`,
    action: `Upgrade ${pkg} to the version this @pithy-sh/multiplayer peers.`,
    detail: `The composed capability carries no \`${key}\`. It was released before optional peers arrived through the composition (#645).`,
  });
}

/**
 * Record the peers this composition holds, refusing one the configured games need and cannot reach. Called by
 * `multiplayer()`'s `compose` hook, once per assembly.
 */
export function composeMultiplayerPeers(capabilities: readonly Capability[], games: readonly ResolvedGame[]): void {
  const ledger = find<LedgerPeer>(capabilities, "ledger", "ledgerConfig", "ledgerPeer", "openLedger");
  const leaderboard = find<LeaderboardPeer>(
    capabilities,
    "leaderboard",
    "leaderboardConfig",
    "leaderboardPeer",
    "entryStore",
  );
  if (ledger.state === "old") throw tooOld("@pithy-sh/ledger", "ledgerPeer", "settles a wager");
  if (leaderboard.state === "old") throw tooOld("@pithy-sh/leaderboard", "leaderboardPeer", "publishes a result");

  const publishing = games.filter((game) => game.leaderboard !== undefined);
  if (publishing.length > 0 && leaderboard.state === "absent") {
    throw new ValidationError({
      message: "A game publishes to a leaderboard, and no leaderboard is composed in this Worker.",
      action:
        "Add `leaderboard(...)` to this Worker's capabilities in pithy.config.ts — the one that composes multiplayer — or drop the game's `leaderboard` block.",
      detail: `Games with a leaderboard block: ${publishing.map((game) => `${game.key} (board "${game.leaderboard?.board}")`).join(", ")}. A session publishes from its Durable Object, which reaches only what its own Worker composes.`,
    });
  }
  const wagering = games.filter((game) => resolveModel(game.kind)?.movesBalances === true);
  if (wagering.length > 0 && ledger.state === "absent") {
    throw new ValidationError({
      message: "A game moves balances, and no ledger is composed in this Worker.",
      action:
        "Add `ledger(...)` to this Worker's capabilities in pithy.config.ts — the one that composes multiplayer — or remove the wagering game.",
      detail: `Games whose model moves balances: ${wagering.map((game) => `${game.key} (${game.kind})`).join(", ")}. A session settles from its Durable Object, which reaches only what its own Worker composes.`,
    });
  }

  composed = {
    ...(ledger.state === "present" ? { ledger: ledger.peer } : {}),
    ...(leaderboard.state === "present" ? { leaderboard: leaderboard.peer } : {}),
  };
}

/** The peers the composition handed over — empty before `compose` has run, or when none is composed. */
export function multiplayerPeers(): MultiplayerPeers {
  return composed;
}
