import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { MatchmakingSnapshot } from "../config/config";

/**
 * The session-minter seam — matchmaking's one dependency on `@pithy-sh/multiplayer`, kept at arm's
 * length. Every pairing path (room code, invite accept, an open-queue match) ends by minting a
 * multiplayer session and seating its roster; this is the single place that does it.
 *
 * The default implementation talks to the `SESSIONS` Durable Object namespace binding directly — the
 * create-then-join dance multiplayer's own routes use (`newUniqueId` → `get` → `create(snapshot, host)`
 * → `join(player)`). It is typed against a minimal local RPC shape, so matchmaking never imports
 * multiplayer. Tests inject a fake minter. Matchmaking's output is always a session id.
 */
export interface SessionMinter {
  /** Mint a session for a game from its snapshot, seat the roster (first id is the creator), return its id. */
  mint(snapshot: MatchmakingSnapshot, players: number, roster: readonly string[]): Promise<string>;
  /** Seat one more player into an already-minted session (the room-code path: host mints, others join). */
  join(sessionId: string, userId: string): Promise<void>;
}

/** The minimal RPC surface the multiplayer session DO exposes — declared locally to avoid a hard dep. */
interface SessionStub {
  create(snapshot: unknown, creatorUserId: string): Promise<{ sessionId: string }>;
  join(userId: string): Promise<{ sessionId: string }>;
}

/** A DO namespace typed to the minimal session stub — what `env.SESSIONS` provides at runtime. */
export interface SessionNamespace {
  newUniqueId(): { toString(): string };
  idFromString(hex: string): unknown;
  get(id: unknown): SessionStub;
}

/**
 * The default minter over a `SESSIONS` DO namespace binding. Builds a multiplayer `GameSnapshot` from the
 * matchmaking snapshot (roster size included), creates the session with the first player as creator, and
 * joins the rest.
 */
export function sessionMinter(sessions: SessionNamespace | undefined): SessionMinter {
  return {
    async mint(snapshot, players, roster) {
      if (!sessions) {
        throw new InternalError({
          detail: "Minting a session requires the SESSIONS Durable Object binding (install @pithy-sh/multiplayer).",
        });
      }
      const [creator, ...rest] = roster;
      if (creator === undefined) {
        throw new InternalError({ detail: "Cannot mint a session for an empty roster." });
      }
      const gameSnapshot = {
        kind: snapshot.kind,
        mode: snapshot.mode,
        players,
        turnTimeoutMs: snapshot.turnTimeoutMs,
        leaderboard: null,
        rules: snapshot.rules,
      };
      const id = sessions.newUniqueId();
      const view = await sessions.get(id).create(gameSnapshot, creator);
      for (const player of rest) {
        await sessions.get(sessions.idFromString(view.sessionId)).join(player);
      }
      return view.sessionId;
    },

    async join(sessionId, userId) {
      if (!sessions) {
        throw new InternalError({
          detail: "Joining a session requires the SESSIONS Durable Object binding (install @pithy-sh/multiplayer).",
        });
      }
      await sessions.get(sessions.idFromString(sessionId)).join(userId);
    },
  };
}
