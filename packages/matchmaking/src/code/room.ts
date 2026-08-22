// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KVNamespace } from "@cloudflare/workers-types";
import type { MatchmakingGame } from "../config/config";
import { MatchmakingInvalidCodeError, MatchmakingRoomFullError, MatchmakingRoomNotFoundError } from "../error/errors";
import { roomStore } from "../kv/rooms";
import type { SessionMinter } from "../session/minter";

/**
 * Room codes — the zero-discovery, play-with-a-friend path. A host opens a room: a multiplayer session is
 * minted (host as creator) and a short, shareable code (`WXYZ-1234`) is stored in KV pointing at it, with
 * a TTL and a limited-use counter. Others redeem the code to join the same session. See the workflow
 * implementation for the code alphabet (ambiguous characters excluded) and the redeem/decrement logic.
 */

/** The result of opening a room. */
export interface RoomCreation {
  /** The shareable join code. */
  code: string;
  /** The multiplayer session the room joins players into. */
  sessionId: string;
}

/** The result of redeeming a room code. */
export interface RoomJoin {
  /** The multiplayer session the joiner was seated into. */
  sessionId: string;
  /** Redemptions the code has left after this join. */
  usesRemaining: number;
}

/** Unambiguous letters for the code prefix — I and O are excluded (they read as 1 and 0). */
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** Unambiguous digits for the code suffix — 0 and 1 are excluded (they read as O and I/L). */
const CODE_DIGITS = "23456789";
/** The canonical shape a normalized code takes: four letters, a dash, four digits. */
const CANONICAL = /^[A-Z]{4}-[0-9]{4}$/;
/** The same shape without its dash — tolerated on input and repaired to canonical. */
const DASHLESS = /^[A-Z]{4}[0-9]{4}$/;

/** Normalize and validate a raw room code (uppercase, canonical form). Throws `matchmaking/invalid_code`. */
export function normalizeCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/\s+/g, "");
  if (CANONICAL.test(cleaned)) return cleaned;
  if (DASHLESS.test(cleaned)) return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
  throw new MatchmakingInvalidCodeError({ detail: `Malformed room code: "${raw}".` });
}

/** Draw `count` characters from `alphabet` using the CSPRNG. */
function pick(alphabet: string, count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

/** Generate a fresh canonical room code (`WXYZ-1234`) from the unambiguous alphabets. */
function generateCode(): string {
  return `${pick(CODE_LETTERS, 4)}-${pick(CODE_DIGITS, 4)}`;
}

/** Open a room: mint a session with `hostId` as creator, store a fresh code in KV, return both. */
export async function createRoom(
  namespace: KVNamespace,
  game: MatchmakingGame,
  minter: SessionMinter,
  hostId: string,
  now: Date,
): Promise<RoomCreation> {
  const sessionId = await minter.mint(game.snapshot, game.players, [hostId]);
  const ttlSeconds = game.roomCodes.ttlSeconds;
  const store = roomStore(namespace, ttlSeconds);

  let code = generateCode();
  while ((await store.get({ code })) !== null) {
    code = generateCode();
  }

  await store.put(
    { code },
    {
      code,
      gameKey: game.key,
      hostId,
      sessionId,
      usesRemaining: game.roomCodes.maxUses,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    },
  );

  return { code, sessionId };
}

/**
 * Redeem a code: seat `userId` into the room's session, decrement uses, re-persist with a TTL recomputed
 * from the room's `expiresAt` (so redeeming does not extend the window). The room value carries everything
 * needed — session id, uses, expiry — so no game config is required here. Throws room_not_found/room_full.
 *
 * Concurrency note: this is a read-modify-write over KV, which has no compare-and-swap, so two simultaneous
 * redemptions of the same code can both read the same `usesRemaining` and both decrement it — a code can be
 * redeemed slightly past `maxUses`. This is intentional and harmless: the multiplayer session's own roster
 * cap is the real guard (an extra joiner past the roster is rejected with `multiplayer/session_full`), so an
 * over-redeemed code cannot over-seat a session; the only effect is that a raced code may outlive its use
 * count by a redemption or two. Making it strictly atomic would mean moving room state into D1 (an atomic
 * `UPDATE … WHERE uses > 0`) or a per-code Durable Object; not worth it for this guarantee.
 */
export async function joinRoom(
  namespace: KVNamespace,
  minter: SessionMinter,
  code: string,
  userId: string,
  now: Date,
): Promise<RoomJoin> {
  // A placeholder TTL just to read — the write below rebuilds the store with the correct remaining window.
  const room = await roomStore(namespace, 60).get({ code });
  if (room === null) {
    throw new MatchmakingRoomNotFoundError({ detail: `No room for code "${code}".` });
  }
  if (room.usesRemaining <= 0) {
    throw new MatchmakingRoomFullError({ detail: `Room "${code}" is spent.` });
  }

  await minter.join(room.sessionId, userId);

  // Recompute the TTL from the room's own expiry so redeeming never extends the window. KV's floor is 60.
  const remaining = Math.max(60, Math.ceil((room.expiresAt.getTime() - now.getTime()) / 1000));
  const usesRemaining = room.usesRemaining - 1;
  await roomStore(namespace, remaining).put({ code }, { ...room, usesRemaining });

  return { sessionId: room.sessionId, usesRemaining };
}
