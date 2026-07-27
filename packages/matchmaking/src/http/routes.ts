import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { fromZodError, InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { createRoom, joinRoom, normalizeCode } from "../code/room";
import { type MatchmakingConfig, type MatchmakingGame, resolveGame } from "../config/config";
import type { Invite } from "../data/invite";
import { matchmakingDatabase } from "../data/tables";
import { MatchmakingInviteForbiddenError, MatchmakingInviteNotFoundError } from "../error/errors";
import { friendStore } from "../friends/store";
import { resolveInvitee } from "../invite/resolve";
import { type InviteStore, inviteStore } from "../invite/store";
import type { MatchmakingPresence } from "../presence/durableObject";
import { PRESENCE_USER_HEADER, type PresenceEvent } from "../presence/protocol";
import type { MatchmakingQueue } from "../queue/durableObject";
import { readSkill } from "../queue/skill";
import { callRpc } from "../rpc";
import { type SessionNamespace, sessionMinter } from "../session/minter";
import { requireAuth } from "./guard";

/**
 * The matchmaking HTTP surface. Every route is `requireAuth()`-gated (no public surface) and binds to
 * `c.var.auth.userId`. Verification strategy: `bearer | session` throughout; the room-code join route may
 * additionally stack a Turnstile humanity check when the adopter opts in (abuse flag).
 *
 * Rooms · POST /games/:game/rooms · POST /rooms/:code/join
 * Invites · POST /games/:game/invites · GET /invites · POST /invites/:id/accept · POST /invites/:id/decline
 * Friends · GET /friends · POST /friends/:userId/request · POST /friends/:userId/accept ·
 *           POST /friends/:userId/decline · DELETE /friends/:userId
 * Queue · POST /games/:game/queue · GET /games/:game/queue · DELETE /games/:game/queue
 * Presence · GET /presence (WebSocket)
 */
export interface MatchmakingRoutesOptions {
  config: MatchmakingConfig;
  basePath?: string;
}

const InviteBody = z
  .object({
    email: z.string().email().optional().describe("The invitee's email — the reliable, unique identity key."),
    name: z.string().min(1).optional().describe("The invitee's screen name — best-effort, may be ambiguous."),
  })
  .refine((b) => (b.email ? 1 : 0) + (b.name ? 1 : 0) === 1, {
    message: "Provide exactly one of `email` or `name`.",
  })
  .describe("Whom to invite: an email or a screen name.");

export function registerMatchmakingRoutes(options: MatchmakingRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/matchmaking";
  const { config } = options;

  return (app) => {
    // --- Rooms ---
    app.post(`${base}/games/:game/rooms`, requireAuth(), async (c) => {
      const game = resolveMatchmakingGame(config, c.req.param("game"));
      const result = await createRoom(kvOf(c), game, minterOf(c), userId(c), new Date());
      return c.json(result, 201);
    });

    app.post(`${base}/rooms/:code/join`, requireAuth(), async (c) => {
      const code = normalizeCode(c.req.param("code"));
      const result = await joinRoom(kvOf(c), minterOf(c), code, userId(c), new Date());
      return c.json(result, 200);
    });

    // --- Invites ---
    app.post(`${base}/games/:game/invites`, requireAuth(), async (c) => {
      const game = resolveMatchmakingGame(config, c.req.param("game"));
      // A direct invite seats exactly two players (inviter + invitee). A game that needs a larger roster
      // cannot be filled this way — use a room code or the open queue — so reject it with a clear error
      // rather than mint a session that can never start.
      if (game.players !== 2) {
        throw new ValidationError({
          message: "Direct invites are for two-player games.",
          action: "Use a room code or the open queue for games with more than two players.",
          detail: `Game "${game.key}" needs ${game.players} players; a direct invite seats only two.`,
        });
      }
      const body = parse(InviteBody, await c.req.json().catch(() => ({})));
      const inviteeId = await resolveInvitee(dbBinding(c), body);
      const invite = await inviteStore(matchmakingDatabase(dbBinding(c))).create({
        id: crypto.randomUUID(),
        gameKey: game.key,
        inviterId: userId(c),
        inviteeId,
        at: new Date(),
      });
      await notify(c, inviteeId, { type: "invite", inviteId: invite.id, gameKey: game.key, from: userId(c) });
      return c.json(invite, 201);
    });

    app.get(`${base}/invites`, requireAuth(), async (c) => {
      const invites = await inviteStore(matchmakingDatabase(dbBinding(c))).pendingFor(userId(c));
      return c.json({ invites });
    });

    app.post(`${base}/invites/:id/accept`, requireAuth(), async (c) => {
      const store = inviteStore(matchmakingDatabase(dbBinding(c)));
      const invite = await requireInvitee(c, store, c.req.param("id"));
      const game = resolveMatchmakingGame(config, invite.gameKey);
      const sessionId = await minterOf(c).mint(game.snapshot, game.players, [invite.inviterId, invite.inviteeId]);
      const accepted = await store.accept(invite.id, sessionId, new Date());
      await notify(c, invite.inviterId, { type: "match_found", sessionId, gameKey: game.key });
      return c.json(accepted, 200);
    });

    app.post(`${base}/invites/:id/decline`, requireAuth(), async (c) => {
      const store = inviteStore(matchmakingDatabase(dbBinding(c)));
      const invite = await requireInvitee(c, store, c.req.param("id"));
      return c.json(await store.decline(invite.id, new Date()), 200);
    });

    // --- Friends ---
    if (config.friends) {
      app.get(`${base}/friends`, requireAuth(), async (c) => {
        const friends = await friendStore(matchmakingDatabase(dbBinding(c))).list(userId(c));
        return c.json({ friends });
      });

      app.post(`${base}/friends/:userId/request`, requireAuth(), async (c) => {
        await friendStore(matchmakingDatabase(dbBinding(c))).request(userId(c), c.req.param("userId"), new Date());
        await notify(c, c.req.param("userId"), { type: "friend_request", from: userId(c) });
        return c.body(null, 204);
      });

      app.post(`${base}/friends/:userId/accept`, requireAuth(), async (c) => {
        await friendStore(matchmakingDatabase(dbBinding(c))).accept(userId(c), c.req.param("userId"), new Date());
        return c.body(null, 204);
      });

      app.post(`${base}/friends/:userId/decline`, requireAuth(), async (c) => {
        await friendStore(matchmakingDatabase(dbBinding(c))).decline(userId(c), c.req.param("userId"));
        return c.body(null, 204);
      });

      app.delete(`${base}/friends/:userId`, requireAuth(), async (c) => {
        await friendStore(matchmakingDatabase(dbBinding(c))).remove(userId(c), c.req.param("userId"));
        return c.body(null, 204);
      });
    }

    // --- Open queue ---
    app.post(`${base}/games/:game/queue`, requireAuth(), async (c) => {
      const game = resolveMatchmakingGame(config, c.req.param("game"));
      const skill = game.skillPool ? await readSkill(dbBinding(c), game.skillPool, userId(c)) : null;
      const status = await callRpc(() =>
        queueStub(c, game.key).enqueue({
          userId: userId(c),
          skill,
          region: region(c),
          gameKey: game.key,
          players: game.players,
          settings: game.queue,
          snapshot: game.snapshot,
        }),
      );
      return c.json(status, 200);
    });

    app.get(`${base}/games/:game/queue`, requireAuth(), async (c) => {
      const game = resolveMatchmakingGame(config, c.req.param("game"));
      return c.json(await callRpc(() => queueStub(c, game.key).status(userId(c))), 200);
    });

    app.delete(`${base}/games/:game/queue`, requireAuth(), async (c) => {
      const game = resolveMatchmakingGame(config, c.req.param("game"));
      await callRpc(() => queueStub(c, game.key).leave(userId(c)));
      return c.body(null, 204);
    });

    // --- Presence (WebSocket) ---
    app.get(`${base}/presence`, requireAuth(), async (c) => {
      const request = new Request(c.req.url, c.req.raw);
      request.headers.set(PRESENCE_USER_HEADER, userId(c));
      return presenceStub(c).fetch(request);
    });
  };
}

// --- helpers ---

function resolveMatchmakingGame(config: MatchmakingConfig, key: string): MatchmakingGame {
  const game = resolveGame(config, key);
  if (!game) {
    throw new NotFoundError({
      message: "That game does not exist.",
      action: "Check the game key against the `games` list in pithy.config.ts.",
      detail: `No matchmaking game "${key}" is configured.`,
    });
  }
  return game;
}

async function requireInvitee(c: Context<PithyHonoEnv>, store: InviteStore, id: string): Promise<Invite> {
  const invite = await store.get(id);
  if (!invite) throw new MatchmakingInviteNotFoundError({ detail: `No invite "${id}".` });
  if (invite.inviteeId !== userId(c)) {
    throw new MatchmakingInviteForbiddenError({ detail: "Only the invitee may respond." });
  }
  return invite;
}

async function notify(c: Context<PithyHonoEnv>, target: string, event: PresenceEvent): Promise<void> {
  try {
    await presenceStub(c).notify(target, event);
  } catch {
    // Best-effort: a notification never fails the action that triggered it.
  }
}

function userId(c: Context<PithyHonoEnv>): string {
  const auth = c.var.auth;
  if (!auth) throw new InternalError({ detail: "requireAuth() must run before a handler reads the user id." });
  return auth.userId;
}

function dbBinding(c: Context<PithyHonoEnv>): D1Database {
  const db = c.env.DB as D1Database | undefined;
  if (!db) throw new InternalError({ detail: "The matchmaking routes require a `DB` D1 binding." });
  return db;
}

function kvOf(c: Context<PithyHonoEnv>): KVNamespace {
  const kv = c.env.MATCHMAKING as KVNamespace | undefined;
  if (!kv) throw new InternalError({ detail: "The matchmaking routes require a `MATCHMAKING` KV binding." });
  return kv;
}

function minterOf(c: Context<PithyHonoEnv>) {
  return sessionMinter(c.env.SESSIONS as SessionNamespace | undefined);
}

function queueStub(c: Context<PithyHonoEnv>, gameKey: string) {
  const ns = c.env.QUEUE as DurableObjectNamespace<MatchmakingQueue> | undefined;
  if (!ns) throw new InternalError({ detail: "The matchmaking routes require a `QUEUE` Durable Object binding." });
  return ns.get(ns.idFromName(gameKey));
}

function presenceStub(c: Context<PithyHonoEnv>) {
  const ns = c.env.PRESENCE as DurableObjectNamespace<MatchmakingPresence> | undefined;
  if (!ns) throw new InternalError({ detail: "The matchmaking routes require a `PRESENCE` Durable Object binding." });
  return ns.get(ns.idFromName("presence"));
}

function region(c: Context<PithyHonoEnv>): string {
  const cf = (c.req.raw as { cf?: { country?: string; colo?: string } }).cf;
  return cf?.country ?? cf?.colo ?? "unknown";
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
