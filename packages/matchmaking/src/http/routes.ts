// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { pageLimit } from "@pithy-sh/core/src/data/cursor";
import { InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { type MatchmakingAuditAction, MatchmakingAuditActions } from "../audit/actions";
import { createRoom, joinRoom, normalizeCode, openRooms } from "../code/room";
import { type MatchmakingConfig, type MatchmakingGame, resolveGame } from "../config/config";
import type { Invite } from "../data/invite";
import { matchmakingDatabase } from "../data/tables";
import { MatchmakingInviteForbiddenError, MatchmakingInviteNotFoundError } from "../error/errors";
import { friendStore } from "../friends/store";
import { resolveInvitee } from "../invite/resolve";
import { type InviteStore, inviteStore } from "../invite/store";
import type { MatchmakingPeers } from "../peers";
import { PRESENCE_PATH } from "../presence/channel";
import type { MatchmakingPresence } from "../presence/durableObject";
import type { PresenceEvent } from "../presence/frames";
import { PRESENCE_USER_HEADER } from "../presence/protocol";
import type { MatchmakingQueue } from "../queue/durableObject";
import { readSkill } from "../queue/skill";
import { callRpc } from "../rpc";
import { type SessionNamespace, sessionMinter } from "../session/minter";
import { requireAuth } from "./guard";
import {
  AdminInviteCanceled,
  AdminInviteList,
  AdminQueue,
  AdminQueuePlayerDropped,
  AdminRoomList,
  FriendList,
  InviteList,
  InviteView,
  QueueStanding,
  RoomCreated,
  RoomJoined,
} from "./responses";
import {
  AdminInvitesQuery,
  AdminModeration,
  AdminQueuePlayerParams,
  AdminRoomsQuery,
  FriendParams,
  GameParams,
  InviteBody,
  InviteParams,
  RoomCodeParams,
} from "./schemas";
import { MATCHMAKING_QUEUES_MODERATE_SCOPE, MATCHMAKING_QUEUES_READ_SCOPE } from "./scopes";
import { adminInviteView, adminQueueTicket, adminRoomView, inviteView } from "./views";

/**
 * The matchmaking HTTP surface. Every route is `requireAuth()`-gated (no public surface) and binds to
 * `c.var.auth.userId`. Verification strategy: `bearer | session` throughout; the room-code join route may
 * additionally stack a Turnstile humanity check when the adopter opts in (abuse flag).
 *
 * Every route also declares what it accepts on its route line, with `validate(target, Schema)` from
 * `./schemas` — always after the guards, so an unauthenticated caller still gets a
 * 401 rather than a 400. A route that reads no request body declares no `json` validator.
 *
 * Rooms · POST /games/:game/rooms (param GameParams) · POST /rooms/:code/join (param RoomCodeParams)
 * Invites · POST /games/:game/invites (param GameParams, json InviteBody) · GET /invites ·
 *           POST /invites/:id/accept (param InviteParams) · POST /invites/:id/decline (param InviteParams)
 * Friends · GET /friends · POST /friends/:userId/request · POST /friends/:userId/accept ·
 *           POST /friends/:userId/decline · DELETE /friends/:userId — each param FriendParams
 * Queue · POST /games/:game/queue · GET /games/:game/queue · DELETE /games/:game/queue — each param GameParams
 * Presence · GET /presence (WebSocket; the raw request is forwarded to the Durable Object, body untouched)
 *
 * ## The management surface, under `admin/`
 *
 * Control-plane routes, gated by `requireControlPlane(scope)` and never by `requireAuth()`: the seam leaves
 * `c.var.auth` null by design, so a player gate on one would refuse every management call forever.
 *
 *   GET  /admin/games/:game/queue               → who is waiting           (matchmaking:queues:read)      param GameParams
 *   GET  /admin/games/:game/rooms               → open rooms               (matchmaking:queues:read)      param GameParams, query AdminRoomsQuery
 *   GET  /admin/invites                         → pending invites, paged   (matchmaking:queues:read)      query AdminInvitesQuery
 *   POST /admin/invites/:id/cancel              → cancel a pending invite  (matchmaking:queues:moderate)  param InviteParams, json AdminModeration
 *   POST /admin/games/:game/queue/:userId/drop  → drop a waiting player    (matchmaking:queues:moderate)  param AdminQueuePlayerParams, json AdminModeration
 *
 * Each act takes an idempotency key and a reason. A retry of the same key changes nothing, tells nobody and
 * emits nothing; a first act tells the players through presence and emits one audit event. **No admin route
 * touches the friend graph**: friend edges are the players' own.
 */
export interface MatchmakingRoutesOptions {
  config: MatchmakingConfig;
  basePath?: string;
  /**
   * The optional peers, read per request — `matchmaking()` hands the slot its `compose` hook fills, because
   * `compose` runs after this factory. Never imported (#645): see `peers.ts`.
   */
  peers?: () => MatchmakingPeers;
}

/**
 * Where matchmaking mounts when an adopter names nothing. Exported because the router and the manifest's
 * `matchmakingAdminRoutes` must agree on it, or a management client composing calls from the manifest 404s.
 */
export const MATCHMAKING_DEFAULT_BASE_PATH = "/matchmaking";

export function registerMatchmakingRoutes(options: MatchmakingRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? MATCHMAKING_DEFAULT_BASE_PATH;
  const { config } = options;

  return (app) => {
    // --- Management (control plane) ---
    app.get(
      `${base}/admin/games/:game/queue`,
      describeRoute({
        summary: "Read who is waiting in one game's queue.",
        description: "Read from the game's queue Durable Object: each player's region, skill, current band, and wait.",
        verification: "control-plane",
        scopes: [MATCHMAKING_QUEUES_READ_SCOPE],
        responses: { 200: AdminQueue },
      }),
      requireControlPlane(MATCHMAKING_QUEUES_READ_SCOPE),
      validate("param", GameParams),
      async (c) => {
        const game = resolveMatchmakingGame(config, c.req.valid("param").game);
        const waiting = await callRpc(() => queueStub(c, game.key).waiting());
        const now = new Date();
        return c.json(
          { gameKey: game.key, waiting: waiting.map((entry) => adminQueueTicket(entry, now)) } satisfies AdminQueue,
          200,
        );
      },
    );

    app.get(
      `${base}/admin/games/:game/rooms`,
      describeRoute({
        summary: "Read one game's open rooms, a page at a time.",
        description:
          "Every game's codes share one list, so a page can hold fewer rooms than asked for. Read on while `nextCursor` is set.",
        verification: "control-plane",
        scopes: [MATCHMAKING_QUEUES_READ_SCOPE],
        responses: { 200: AdminRoomList },
      }),
      requireControlPlane(MATCHMAKING_QUEUES_READ_SCOPE),
      validate("param", GameParams),
      validate("query", AdminRoomsQuery),
      async (c) => {
        const game = resolveMatchmakingGame(config, c.req.valid("param").game);
        const query = c.req.valid("query");
        const page = await openRooms(kvOf(c), game, { cursor: query.cursor, limit: pageLimit(query.limit) });
        return c.json(
          {
            gameKey: game.key,
            rooms: page.rooms.map((room) => adminRoomView(room, game.players)),
            nextCursor: page.nextCursor,
          } satisfies AdminRoomList,
          200,
        );
      },
    );

    app.get(
      `${base}/admin/invites`,
      describeRoute({
        summary: "List every pending invite, a page at a time.",
        verification: "control-plane",
        scopes: [MATCHMAKING_QUEUES_READ_SCOPE],
        responses: { 200: AdminInviteList },
      }),
      requireControlPlane(MATCHMAKING_QUEUES_READ_SCOPE),
      validate("query", AdminInvitesQuery),
      async (c) => {
        const query = c.req.valid("query");
        // A game filter is still config-backed: a mistyped key is the capability's own 404, not an empty pane.
        const gameKey = query.game === undefined ? undefined : resolveMatchmakingGame(config, query.game).key;
        const page = await inviteStore(matchmakingDatabase(dbBinding(c))).listPending({
          gameKey,
          cursor: query.cursor,
          limit: query.limit,
        });
        const now = new Date();
        return c.json(
          {
            invites: page.items.map((invite) => adminInviteView(invite, now)),
            nextCursor: page.nextCursor,
          } satisfies AdminInviteList,
          200,
        );
      },
    );

    app.post(
      `${base}/admin/invites/:id/cancel`,
      describeRoute({
        summary: "Cancel a pending invite.",
        description:
          "Both players are told through presence. A retry with the same `idempotencyKey` changes nothing and answers `replayed: true`.",
        verification: "control-plane",
        scopes: [MATCHMAKING_QUEUES_MODERATE_SCOPE],
        responses: { 200: AdminInviteCanceled },
      }),
      requireControlPlane(MATCHMAKING_QUEUES_MODERATE_SCOPE),
      validate("param", InviteParams),
      validate("json", AdminModeration),
      async (c) => {
        const { id } = c.req.valid("param");
        const { idempotencyKey, reason } = c.req.valid("json");
        const outcome = await inviteStore(matchmakingDatabase(dbBinding(c))).cancel(id, idempotencyKey, new Date());
        const { invite } = outcome;
        if (!outcome.replayed) {
          const frame: PresenceEvent = { type: "invite_canceled", inviteId: invite.id, gameKey: invite.gameKey };
          await notify(c, invite.inviterId, frame);
          await notify(c, invite.inviteeId, frame);
          await record(c, MatchmakingAuditActions.inviteCanceled, {
            resourceType: "matchmaking_invite",
            resourceId: invite.id,
            gameKey: invite.gameKey,
            target: { inviteId: invite.id, inviterId: invite.inviterId, inviteeId: invite.inviteeId },
            reason,
            idempotencyKey,
          });
        }
        return c.json({ invite: inviteView(invite), replayed: outcome.replayed } satisfies AdminInviteCanceled, 200);
      },
    );

    app.post(
      `${base}/admin/games/:game/queue/:userId/drop`,
      describeRoute({
        summary: "Drop a player from one game's queue.",
        description:
          "The player's presence socket is told why, in the `reason` sent. A retry with the same `idempotencyKey` changes nothing and answers `replayed: true`.",
        verification: "control-plane",
        scopes: [MATCHMAKING_QUEUES_MODERATE_SCOPE],
        responses: { 200: AdminQueuePlayerDropped },
      }),
      requireControlPlane(MATCHMAKING_QUEUES_MODERATE_SCOPE),
      validate("param", AdminQueuePlayerParams),
      validate("json", AdminModeration),
      async (c) => {
        const params = c.req.valid("param");
        const game = resolveMatchmakingGame(config, params.game);
        const { idempotencyKey, reason } = c.req.valid("json");
        const outcome = await callRpc(() => queueStub(c, game.key).drop(params.userId, idempotencyKey));
        if (!outcome.replayed) {
          await notify(c, params.userId, { type: "queue_dropped", gameKey: game.key, reason });
          await record(c, MatchmakingAuditActions.queuePlayerDropped, {
            resourceType: "matchmaking_queue_ticket",
            resourceId: `${game.key}:${params.userId}`,
            gameKey: game.key,
            target: { userId: params.userId },
            reason,
            idempotencyKey,
          });
        }
        return c.json(
          { gameKey: game.key, userId: params.userId, replayed: outcome.replayed } satisfies AdminQueuePlayerDropped,
          200,
        );
      },
    );

    // --- Rooms ---
    app.post(
      `${base}/games/:game/rooms`,
      describeRoute({
        summary: "Open a room with a shareable join code.",
        verification: ["bearer", "session"],
        responses: { 201: RoomCreated },
      }),
      requireAuth(),
      validate("param", GameParams),
      async (c) => {
        const game = resolveMatchmakingGame(config, c.req.valid("param").game);
        const result = await createRoom(kvOf(c), game, minterOf(c), userId(c), new Date());
        return c.json(result satisfies RoomCreated, 201);
      },
    );

    app.post(
      `${base}/rooms/:code/join`,
      describeRoute({
        summary: "Join a room by its code.",
        verification: ["bearer", "session"],
        responses: { 200: RoomJoined },
      }),
      requireAuth(),
      validate("param", RoomCodeParams),
      async (c) => {
        // The param schema is a length bound; `normalizeCode` still owns the code's real shape.
        const code = normalizeCode(c.req.valid("param").code);
        const result = await joinRoom(kvOf(c), minterOf(c), code, userId(c), new Date());
        return c.json(result satisfies RoomJoined, 200);
      },
    );

    // --- Invites ---
    app.post(
      `${base}/games/:game/invites`,
      describeRoute({
        summary: "Invite another player to a two-player game.",
        description: "Name the invitee by `email` or by screen `name`, never both.",
        verification: ["bearer", "session"],
        responses: { 201: InviteView },
      }),
      requireAuth(),
      validate("param", GameParams),
      validate("json", InviteBody),
      async (c) => {
        const game = resolveMatchmakingGame(config, c.req.valid("param").game);
        // A direct invite seats exactly two players (inviter + invitee). A game that needs a larger roster
        // cannot be filled this way — use a room code or the open queue — so reject it with a clear error
        // rather than mint a session that can never start. Hand-thrown, not Zod: the roster is config, not
        // request shape, so no body schema can express it.
        if (game.players !== 2) {
          throw new ValidationError({
            message: "Direct invites are for two-player games.",
            action: "Use a room code or the open queue for games with more than two players.",
            detail: `Game "${game.key}" needs ${game.players} players; a direct invite seats only two.`,
          });
        }
        const inviteeId = await resolveInvitee(dbBinding(c), c.req.valid("json"), options.peers?.().auth);
        const invite = await inviteStore(matchmakingDatabase(dbBinding(c))).create({
          id: crypto.randomUUID(),
          gameKey: game.key,
          inviterId: userId(c),
          inviteeId,
          at: new Date(),
        });
        await notify(c, inviteeId, { type: "invite", inviteId: invite.id, gameKey: game.key, from: userId(c) });
        return c.json(inviteView(invite) satisfies InviteView, 201);
      },
    );

    app.get(
      `${base}/invites`,
      describeRoute({
        summary: "List the invites waiting on the caller.",
        verification: ["bearer", "session"],
        responses: { 200: InviteList },
      }),
      requireAuth(),
      async (c) => {
        const invites = await inviteStore(matchmakingDatabase(dbBinding(c))).pendingFor(userId(c));
        return c.json({ invites: invites.map(inviteView) } satisfies InviteList);
      },
    );

    app.post(
      `${base}/invites/:id/accept`,
      describeRoute({
        summary: "Accept an invite and start its session.",
        verification: ["bearer", "session"],
        responses: { 200: InviteView },
      }),
      requireAuth(),
      validate("param", InviteParams),
      async (c) => {
        const store = inviteStore(matchmakingDatabase(dbBinding(c)));
        const invite = await requireInvitee(c, store, c.req.valid("param").id);
        const game = resolveMatchmakingGame(config, invite.gameKey);
        const sessionId = await minterOf(c).mint(game.snapshot, game.players, [invite.inviterId, invite.inviteeId]);
        const accepted = await store.accept(invite.id, sessionId, new Date());
        await notify(c, invite.inviterId, { type: "match_found", sessionId, gameKey: game.key });
        return c.json(inviteView(accepted) satisfies InviteView, 200);
      },
    );

    app.post(
      `${base}/invites/:id/decline`,
      describeRoute({
        summary: "Decline an invite.",
        verification: ["bearer", "session"],
        responses: { 200: InviteView },
      }),
      requireAuth(),
      validate("param", InviteParams),
      async (c) => {
        const store = inviteStore(matchmakingDatabase(dbBinding(c)));
        const invite = await requireInvitee(c, store, c.req.valid("param").id);
        const declined = await store.decline(invite.id, new Date());
        return c.json(inviteView(declined) satisfies InviteView, 200);
      },
    );

    // --- Friends ---
    if (config.friends) {
      app.get(
        `${base}/friends`,
        describeRoute({
          summary: "List the caller's friends and pending requests.",
          verification: ["bearer", "session"],
          responses: { 200: FriendList },
        }),
        requireAuth(),
        async (c) => {
          const friends = await friendStore(matchmakingDatabase(dbBinding(c))).list(userId(c));
          return c.json({ friends });
        },
      );

      app.post(
        `${base}/friends/:userId/request`,
        describeRoute({
          summary: "Send a friend request.",
          verification: ["bearer", "session"],
          responses: { 204: { description: "The request was sent." } },
        }),
        requireAuth(),
        validate("param", FriendParams),
        async (c) => {
          const other = c.req.valid("param").userId;
          await friendStore(matchmakingDatabase(dbBinding(c))).request(userId(c), other, new Date());
          await notify(c, other, { type: "friend_request", from: userId(c) });
          return c.body(null, 204);
        },
      );

      app.post(
        `${base}/friends/:userId/accept`,
        describeRoute({
          summary: "Accept a friend request.",
          verification: ["bearer", "session"],
          responses: { 204: { description: "The two players are now friends." } },
        }),
        requireAuth(),
        validate("param", FriendParams),
        async (c) => {
          await friendStore(matchmakingDatabase(dbBinding(c))).accept(
            userId(c),
            c.req.valid("param").userId,
            new Date(),
          );
          return c.body(null, 204);
        },
      );

      app.post(
        `${base}/friends/:userId/decline`,
        describeRoute({
          summary: "Decline a friend request.",
          verification: ["bearer", "session"],
          responses: { 204: { description: "The request was declined." } },
        }),
        requireAuth(),
        validate("param", FriendParams),
        async (c) => {
          await friendStore(matchmakingDatabase(dbBinding(c))).decline(userId(c), c.req.valid("param").userId);
          return c.body(null, 204);
        },
      );

      app.delete(
        `${base}/friends/:userId`,
        describeRoute({
          summary: "Remove a friend.",
          verification: ["bearer", "session"],
          responses: { 204: { description: "The friendship was removed." } },
        }),
        requireAuth(),
        validate("param", FriendParams),
        async (c) => {
          await friendStore(matchmakingDatabase(dbBinding(c))).remove(userId(c), c.req.valid("param").userId);
          return c.body(null, 204);
        },
      );
    }

    // --- Open queue ---
    app.post(
      `${base}/games/:game/queue`,
      describeRoute({
        summary: "Join a game's open queue.",
        verification: ["bearer", "session"],
        responses: { 200: QueueStanding },
      }),
      requireAuth(),
      validate("param", GameParams),
      async (c) => {
        const game = resolveMatchmakingGame(config, c.req.valid("param").game);
        const skill = game.skillPool
          ? await readSkill(dbBinding(c), game.skillPool, userId(c), options.peers?.().rating)
          : null;
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
      },
    );

    app.get(
      `${base}/games/:game/queue`,
      describeRoute({
        summary: "Read the caller's standing in a game's queue.",
        description: "A match is delivered once: the read that reports it clears it.",
        verification: ["bearer", "session"],
        responses: { 200: QueueStanding },
      }),
      requireAuth(),
      validate("param", GameParams),
      async (c) => {
        const game = resolveMatchmakingGame(config, c.req.valid("param").game);
        return c.json(await callRpc(() => queueStub(c, game.key).status(userId(c))), 200);
      },
    );

    app.delete(
      `${base}/games/:game/queue`,
      describeRoute({
        summary: "Leave a game's open queue.",
        verification: ["bearer", "session"],
        responses: { 204: { description: "The caller is no longer queued." } },
      }),
      requireAuth(),
      validate("param", GameParams),
      async (c) => {
        const game = resolveMatchmakingGame(config, c.req.valid("param").game);
        await callRpc(() => queueStub(c, game.key).leave(userId(c)));
        return c.body(null, 204);
      },
    );

    // --- Presence (WebSocket) ---
    app.get(
      `${base}${PRESENCE_PATH}`,
      describeRoute({
        summary: "Open the caller's presence socket.",
        description:
          "Send `Upgrade: websocket`, and offer `pithy.presence.v1` in `Sec-WebSocket-Protocol`. The socket first receives the caller's pending invites and which accepted friends are online, then invites, friend requests and matches as they happen. Send `ping` to get `pong`. The frames are in the AsyncAPI contract.",
        verification: ["bearer", "session"],
        responses: {
          101: { description: "Switches to a WebSocket. The server pushes presence events as JSON text frames." },
        },
      }),
      requireAuth(),
      async (c) => {
        const request = new Request(c.req.url, c.req.raw);
        request.headers.set(PRESENCE_USER_HEADER, userId(c));
        return presenceStub(c).fetch(request);
      },
    );
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
  // Checked before anything is minted: an answered or canceled invite cannot start a session.
  if (invite.status !== "pending") {
    throw new MatchmakingInviteNotFoundError({ detail: `Invite "${id}" is ${invite.status}, not pending.` });
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

/**
 * The verified management client behind a control-plane call. `requireControlPlane()` has run on every route that
 * calls this, so a null is a route mounted without its gate — a wiring mistake, hence `InternalError`.
 */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({
      message: "Matchmaking could not identify the management caller.",
      detail: "requireControlPlane() must run before a matchmaking management handler reads the caller.",
    });
  }
  return context;
}

/** What one management act records beyond who did it. */
interface ActRecord {
  resourceType: string;
  resourceId: string;
  gameKey: string;
  target: Record<string, string>;
  reason: string;
  idempotencyKey: string;
}

/**
 * Record one management act, once, through the core `emit` seam: the connection, the game, the target and the
 * reason. Called only when the act changed something — a replay and a refusal record nothing.
 */
async function record(c: Context<PithyHonoEnv>, action: MatchmakingAuditAction, act: ActRecord): Promise<void> {
  const who = caller(c);
  await c.var.emit({
    action,
    outcome: "success",
    severity: "warning",
    actorType: "control-plane",
    actorId: who.subject,
    resourceType: act.resourceType,
    resourceId: act.resourceId,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: {
      connectionId: who.connectionId,
      gameKey: act.gameKey,
      ...act.target,
      reason: act.reason,
      idempotencyKey: act.idempotencyKey,
    },
  });
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
