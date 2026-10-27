// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, DurableObjectNamespace, DurableObjectStub } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { negotiateSubprotocol, SUBPROTOCOL_HEADER } from "@pithy-sh/core/src/http/subprotocol";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { type MultiplayerAuditAction, MultiplayerAuditActions } from "../audit/actions";
import { type ResolvedGame, resolveGame } from "../config/config";
import { sessionIndex } from "../data/sessionStore";
import { resultStore } from "../data/store";
import { multiplayerDatabase } from "../data/tables";
import { MultiplayerGameNotFoundError, MultiplayerSessionNotFoundError } from "../error/errors";
import { callSession } from "../session/call";
// Type-only, so it erases: the DO module imports `cloudflare:workers` and must never land on the value
// import graph the adopter's `pithy.config.ts` pulls in. The two constants both sides need live in the
// pure `session/protocol` module for the same reason (#172).
import { multiplayerSocketPath } from "../session/channel";
import type { MultiplayerSession } from "../session/durableObject";
import { MULTIPLAYER_SOCKET_VERSIONS } from "../session/frames";
import { multiplayerPeers } from "../session/peers";
import { USER_HEADER } from "../session/protocol";
import type { GameSnapshot } from "../session/state";
import { voidMultiplayerResult } from "../void/void";
import { requireAuth } from "./guard";
import {
  AdminResultList,
  AdminResultVoided,
  AdminSessionClosed,
  AdminSessionList,
  SessionInspection,
  SessionResult,
  SessionView,
} from "./responses";
import {
  AdminAct,
  AdminResultsQuery,
  AdminSessionsQuery,
  MultiplayerGameParams,
  MultiplayerSessionParams,
} from "./schemas";
import { MULTIPLAYER_SESSIONS_MODERATE_SCOPE, MULTIPLAYER_SESSIONS_READ_SCOPE } from "./scopes";
import { adminResultView, adminSessionListItem, sessionResultView } from "./views";

/**
 * The multiplayer routes, their declared verification strategies, and what they accept. Every route is
 * `bearer | session` — gated by {@link requireAuth} — because membership binds to an authenticated user id
 * and there is no public session surface:
 *
 * | Method | Path                             | Strategy          | Validates                       |
 * |--------|----------------------------------|-------------------|---------------------------------|
 * | POST   | /multiplayer/games/:game         | bearer \| session | param `MultiplayerGameParams`    |
 * | POST   | /multiplayer/sessions/:id/join   | bearer \| session | param `MultiplayerSessionParams` |
 * | POST   | /multiplayer/sessions/:id/action | bearer \| session | param `MultiplayerSessionParams` |
 * | POST   | /multiplayer/sessions/:id/leave  | bearer \| session | param `MultiplayerSessionParams` |
 * | POST   | /multiplayer/sessions/:id/close  | bearer \| session | param `MultiplayerSessionParams` |
 * | GET    | /multiplayer/sessions/:id/result | bearer \| session | param `MultiplayerSessionParams` |
 * | GET    | /multiplayer/sessions/:id/socket | bearer \| session | param `MultiplayerSessionParams` |
 * | GET    | /multiplayer/sessions/:id        | bearer \| session | param `MultiplayerSessionParams` |
 *
 * Validators run **after** {@link requireAuth}, so an unauthenticated caller is still denied 401 whatever it
 * sends. The param schemas bound a segment's shape only: resolving a game key stays in the handler (an
 * unknown game is still a 404), and judging a session id stays in {@link sessionStub} (an unparseable id is
 * still a 404).
 *
 * **No route declares a json schema, including the one route that reads a body.** An action is whatever the
 * game's model defines — a commit for a commit-reveal game, a cell for a sequential grid — and the route
 * forwards its JSON body to the session, which parses it with the model's own `action` schema when the model
 * declares one (a malformed action is a `validation/invalid_input` 400, from the session, after membership
 * and phase are judged). There is no shape for this capability to impose, and a `validate("json", …)` would
 * still change what a caller may send: it rejects an empty body under a JSON content-type with a 400, where
 * a body-less action legitimately reaches a model that takes no payload. So the body is read off the raw
 * request instead, with the same "unreadable body means no payload" fallback — the model decides what is legal.
 * The join, leave, and close routes read no body at all, so validating one on them would only 400 the
 * body-less request their clients already send.
 *
 * The authenticated user id comes from the core `AuthContext` seam (`c.var.auth.userId`) and is passed to the
 * Durable Object on every call — the DO never trusts a client-supplied id. The WebSocket upgrade is forwarded
 * to the DO with that id set on {@link USER_HEADER}, a server-set header the DO trusts.
 *
 * ## The management surface, under `admin/` (#820)
 *
 * Control-plane routes, gated by `requireControlPlane(scope)` and never by `requireAuth()`: the seam leaves
 * `c.var.auth` null by design, so a player gate on one would refuse every management call forever.
 *
 *   GET  /admin/sessions             → sessions in flight, paged  (multiplayer:sessions:read)      query AdminSessionsQuery
 *   GET  /admin/sessions/:id         → one session, from its DO   (multiplayer:sessions:read)      param MultiplayerSessionParams
 *   POST /admin/sessions/:id/close   → close a session in flight  (multiplayer:sessions:moderate)  param MultiplayerSessionParams, json AdminAct
 *   GET  /admin/results              → results, paged             (multiplayer:sessions:read)      query AdminResultsQuery
 *   POST /admin/results/:id/void     → void a result, cascading   (multiplayer:sessions:moderate)  param MultiplayerSessionParams, json AdminAct
 *
 * Each act takes an idempotency key and a reason, and emits one audit event when it changed something. The
 * void calls every composed consumer and reports each, consumer by consumer (`void/void.ts`).
 */
export interface MultiplayerRoutesOptions {
  /** The games, validated against their models at assembly (each carries parsed `rules`). */
  games: readonly ResolvedGame[];
  basePath?: string;
}

/** The `SESSIONS` Durable Object namespace binding, typed to the session class. */
type SessionsNamespace = DurableObjectNamespace<MultiplayerSession>;

/**
 * The authenticated player's id. `requireAuth` runs before every handler, so `c.var.auth` is set — this
 * reads it defensively (throwing rather than asserting non-null) so a misordered middleware surfaces as a
 * clear error, never a crash.
 */
function userId(c: Context<PithyHonoEnv>): string {
  const auth = c.var.auth;
  if (!auth) {
    throw new InternalError({ detail: "requireAuth() must run before a multiplayer handler reads the user id." });
  }
  return auth.userId;
}

/** Read the `SESSIONS` binding off the env, or fail with a configuration error naming the missing binding. */
function sessionsBinding(c: Context<PithyHonoEnv>): SessionsNamespace {
  const binding = (c.env as Record<string, unknown>).SESSIONS as SessionsNamespace | undefined;
  if (!binding) {
    throw new InternalError({
      message: "Multiplayer is not configured.",
      action: "Bind a Durable Object namespace named SESSIONS in wrangler.jsonc.",
      detail: "The multiplayer capability requires a `SESSIONS` durable_object binding; none was present on env.",
    });
  }
  return binding;
}

/** Resolve a session stub from a path id, mapping an unparseable id to a 404 rather than a 500. */
function sessionStub(namespace: SessionsNamespace, rawId: string): DurableObjectStub<MultiplayerSession> {
  let id: ReturnType<SessionsNamespace["idFromString"]>;
  try {
    id = namespace.idFromString(rawId);
  } catch (cause) {
    throw new MultiplayerSessionNotFoundError({ detail: `"${rawId}" is not a valid session id.` }, { cause });
  }
  return namespace.get(id);
}

/** Build the config snapshot the DO stores from a validated game — nullable fields normalized for storage. */
function snapshot(game: ResolvedGame): GameSnapshot {
  return {
    key: game.key,
    kind: game.kind,
    mode: game.mode,
    players: game.players,
    turnTimeoutMs: game.turnTimeoutMs ?? null,
    leaderboard: game.leaderboard ?? null,
    rules: game.rules,
  };
}

/**
 * Where multiplayer mounts when an adopter names nothing. Exported because the router and the manifest's
 * `multiplayerAdminRoutes` must agree on it, or a management client composing calls from the manifest 404s.
 */
export const MULTIPLAYER_DEFAULT_BASE_PATH = "/multiplayer";

/** A game filter resolved against config: a mistyped key is the capability's own 404, not an empty pane. */
function filteredGame(games: readonly ResolvedGame[], key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const game = resolveGame(games, key);
  if (!game) throw new MultiplayerGameNotFoundError({ detail: `No game "${key}" is configured.` });
  return game.key;
}

/** Read the `DB` binding off the env, or fail with a configuration error naming the missing binding. */
function dbBinding(c: Context<PithyHonoEnv>): D1Database {
  const binding = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!binding) {
    throw new InternalError({
      message: "Multiplayer is not configured.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "The multiplayer capability requires a `DB` d1 binding; none was present on env.",
    });
  }
  return binding;
}

/**
 * The verified management client behind a control-plane call. `requireControlPlane()` has run on every route that
 * calls this, so a null is a route mounted without its gate — a wiring mistake, hence `InternalError`.
 */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({
      message: "Multiplayer could not identify the management caller.",
      detail: "requireControlPlane() must run before a multiplayer management handler reads the caller.",
    });
  }
  return context;
}

/** What one management act records beyond who did it. */
interface ActRecord {
  sessionId: string;
  gameKey: string;
  details: Record<string, unknown>;
  reason: string;
  idempotencyKey: string;
}

/**
 * Record one management act, once, through the core `emit` seam: the connection, the session, the game and the
 * reason. Called only when the act changed something — a replay and a refusal record nothing.
 */
async function record(c: Context<PithyHonoEnv>, action: MultiplayerAuditAction, act: ActRecord): Promise<void> {
  const who = caller(c);
  await c.var.emit({
    action,
    outcome: "success",
    severity: "warning",
    actorType: "control-plane",
    actorId: who.subject,
    resourceType: "multiplayer_session",
    resourceId: act.sessionId,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: {
      connectionId: who.connectionId,
      gameKey: act.gameKey,
      ...act.details,
      reason: act.reason,
      idempotencyKey: act.idempotencyKey,
    },
  });
}

export function registerMultiplayerRoutes(options: MultiplayerRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? MULTIPLAYER_DEFAULT_BASE_PATH;
  const { games } = options;

  return (app) => {
    // --- Management (control plane, #820) ---
    app.get(
      `${base}/admin/sessions`,
      describeRoute({
        summary: "List the sessions in flight, newest first, a page at a time.",
        description:
          "Read from the session index each session writes when it opens and removes when it ends. A session in flight before the index existed appears at its next join, leave or phase change.",
        verification: "control-plane",
        scopes: [MULTIPLAYER_SESSIONS_READ_SCOPE],
        responses: { 200: AdminSessionList },
      }),
      requireControlPlane(MULTIPLAYER_SESSIONS_READ_SCOPE),
      validate("query", AdminSessionsQuery),
      async (c) => {
        const query = c.req.valid("query");
        const page = await sessionIndex(multiplayerDatabase(dbBinding(c))).list({
          gameKey: filteredGame(games, query.game),
          cursor: query.cursor,
          limit: query.limit,
        });
        const now = new Date();
        return c.json(
          {
            sessions: page.items.map((entry) => adminSessionListItem(entry, now)),
            nextCursor: page.nextCursor,
          } satisfies AdminSessionList,
          200,
        );
      },
    );

    app.get(
      `${base}/admin/sessions/:id`,
      describeRoute({
        summary: "Read one session from its Durable Object.",
        description:
          "Its players, phase, deadline, who is connected, and how it ended. Never the game's state, which holds what a player must not see.",
        verification: "control-plane",
        scopes: [MULTIPLAYER_SESSIONS_READ_SCOPE],
        responses: { 200: SessionInspection },
      }),
      requireControlPlane(MULTIPLAYER_SESSIONS_READ_SCOPE),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        return c.json((await callSession(() => stub.inspect())) satisfies SessionInspection, 200);
      },
    );

    app.post(
      `${base}/admin/sessions/:id/close`,
      describeRoute({
        summary: "Close a session in flight.",
        description:
          "It records no result. A table settles each seated player out first, releasing what they hold. Every member gets a last state frame carrying the `reason`, and their sockets close. A retry with the same `idempotencyKey` changes nothing and answers `replayed: true`. A session that already ended is `multiplayer/invalid_transition`.",
        verification: "control-plane",
        scopes: [MULTIPLAYER_SESSIONS_MODERATE_SCOPE],
        responses: { 200: AdminSessionClosed },
      }),
      requireControlPlane(MULTIPLAYER_SESSIONS_MODERATE_SCOPE),
      validate("param", MultiplayerSessionParams),
      validate("json", AdminAct),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const { idempotencyKey, reason } = c.req.valid("json");
        const outcome = await callSession(() => stub.closeByOperator(idempotencyKey, reason));
        if (!outcome.replayed) {
          await record(c, MultiplayerAuditActions.sessionClosed, {
            sessionId: outcome.session.sessionId,
            gameKey: outcome.session.gameKey,
            details: { players: outcome.session.players },
            reason,
            idempotencyKey,
          });
        }
        return c.json({ session: outcome.session, replayed: outcome.replayed } satisfies AdminSessionClosed, 200);
      },
    );

    app.get(
      `${base}/admin/results`,
      describeRoute({
        summary: "List results, most recently ended first, a page at a time.",
        verification: "control-plane",
        scopes: [MULTIPLAYER_SESSIONS_READ_SCOPE],
        responses: { 200: AdminResultList },
      }),
      requireControlPlane(MULTIPLAYER_SESSIONS_READ_SCOPE),
      validate("query", AdminResultsQuery),
      async (c) => {
        const query = c.req.valid("query");
        const page = await resultStore(dbBinding(c)).list({
          gameKey: filteredGame(games, query.game),
          voided: query.voided,
          cursor: query.cursor,
          limit: query.limit,
        });
        return c.json(
          { results: page.items.map(adminResultView), nextCursor: page.nextCursor } satisfies AdminResultList,
          200,
        );
      },
    );

    app.post(
      `${base}/admin/results/:id/void`,
      describeRoute({
        summary: "Void a result, and take it back out of every composed consumer.",
        description:
          "The result is marked void, then each composed consumer is called with its id: the leaderboard removes the entries it put on a board, and rating recalculates every player it touched. The response lists each consumer's outcome, and a consumer that failed is named. A retry with the same `idempotencyKey` changes nothing, and so does voiding a result already void with every consumer done. A new key on a void with a consumer still `failed` or `pending` runs those consumers again; while a consumer is `pending` and the key holding the void was spent less than 15 minutes ago, the void may still be running, and a new key is a 409 `core/conflict` that changes nothing.",
        verification: "control-plane",
        scopes: [MULTIPLAYER_SESSIONS_MODERATE_SCOPE],
        responses: { 200: AdminResultVoided },
      }),
      requireControlPlane(MULTIPLAYER_SESSIONS_MODERATE_SCOPE),
      validate("param", MultiplayerSessionParams),
      validate("json", AdminAct),
      async (c) => {
        const { id } = c.req.valid("param");
        const { idempotencyKey, reason } = c.req.valid("json");
        const outcome = await voidMultiplayerResult(
          dbBinding(c),
          multiplayerPeers().voidConsumers ?? [],
          { sessionId: id, idempotencyKey },
          new Date(),
          c.var.log,
        );
        if (!outcome.replayed) {
          await record(c, MultiplayerAuditActions.resultVoided, {
            sessionId: outcome.result.sessionId,
            gameKey: outcome.result.gameKey,
            details: {
              players: outcome.result.players,
              consumers: outcome.consumers.map(({ consumer, status }) => ({ consumer, status })),
            },
            reason,
            idempotencyKey,
          });
        }
        return c.json(
          {
            result: adminResultView(outcome.result),
            replayed: outcome.replayed,
            consumers: outcome.consumers,
          } satisfies AdminResultVoided,
          200,
        );
      },
    );

    // Create a session for a configured game. The creator is its first member.
    app.post(
      `${base}/games/:game`,
      describeRoute({
        summary: "Start a session of a configured game.",
        description: "The caller becomes the session's first member.",
        verification: ["bearer", "session"],
        responses: { 201: SessionView },
      }),
      requireAuth(),
      validate("param", MultiplayerGameParams),
      async (c) => {
        const gameKey = c.req.valid("param").game;
        const game = resolveGame(games, gameKey);
        if (!game) throw new MultiplayerGameNotFoundError({ detail: `No game "${gameKey}" is configured.` });

        const namespace = sessionsBinding(c);
        const id = namespace.newUniqueId();
        const stub = namespace.get(id);
        const view = await callSession(() => stub.create(snapshot(game), userId(c)));
        return c.json(view, 201);
      },
    );

    app.post(
      `${base}/sessions/:id/join`,
      describeRoute({
        summary: "Join a session.",
        verification: ["bearer", "session"],
        responses: { 200: SessionView },
      }),
      requireAuth(),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const view = await callSession(() => stub.join(userId(c)));
        return c.json(view, 200);
      },
    );

    app.post(
      `${base}/sessions/:id/action`,
      describeRoute({
        summary: "Take a turn in a session.",
        description:
          "The JSON body is the action itself, in whatever shape the game's model defines — its `<gameKey>.action` schema in the AsyncAPI document, where it declares one. A body that schema refuses is a `validation/invalid_input` 400. A missing or unreadable body reaches the model as no payload.",
        verification: ["bearer", "session"],
        responses: { 200: SessionView },
      }),
      requireAuth(),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        // The action payload is the one thing this capability does not shape — it belongs to the game's
        // model (see the docblock), so it is read raw and forwarded. Read off `c.req.raw` rather than
        // declared as a json validator so a body-less action still reaches a model that takes no payload,
        // instead of becoming a 400.
        const body = await c.req.raw.json().catch(() => undefined);
        const view = await callSession(() => stub.action(userId(c), body));
        return c.json(view, 200);
      },
    );

    // Table mode: take or leave a seat, or close the table. Neither reads a body.
    app.post(
      `${base}/sessions/:id/leave`,
      describeRoute({
        summary: "Leave a seat at a table.",
        description:
          "Only a player who joined may leave; anyone else is `multiplayer/not_a_member`. Leaving closes the player's sockets. A repeated leave is not an error, and shows nothing live.",
        verification: ["bearer", "session"],
        responses: { 200: SessionView },
      }),
      requireAuth(),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        return c.json(await callSession(() => stub.leave(userId(c))), 200);
      },
    );

    app.post(
      `${base}/sessions/:id/close`,
      describeRoute({
        summary: "Close a table.",
        verification: ["bearer", "session"],
        responses: { 200: SessionView },
      }),
      requireAuth(),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        return c.json(await callSession(() => stub.close(userId(c))), 200);
      },
    );

    app.get(
      `${base}/sessions/:id/result`,
      describeRoute({
        summary: "Read how a finished session ended.",
        description:
          "Anyone who ever joined the session may read it, a player who left included. Anyone else is `multiplayer/not_a_member`, before the session says whether it has ended.",
        verification: ["bearer", "session"],
        responses: { 200: SessionResult },
      }),
      requireAuth(),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const result = await callSession(() => stub.result(userId(c)));
        if (!result) throw new MultiplayerSessionNotFoundError({ detail: "The session has no terminal result yet." });
        return c.json(sessionResultView(result) satisfies SessionResult, 200);
      },
    );

    // The WebSocket upgrade — forwarded to the DO with the authenticated id set on the trusted header. The
    // DO answers a non-upgrade request with 426, so the check lives there, once. The subprotocol is
    // negotiated here first, so an offer this Worker does not serve is the ordinary 400 JSON error before
    // any upgrade; the DO negotiates the same header again to choose what it answers the 101 with.
    app.get(
      multiplayerSocketPath(base),
      describeRoute({
        summary: "Open a live socket on a session.",
        description:
          "Send `Upgrade: websocket`. Only a member of the session may connect. Offer `pithy.multiplayer.v1` in `Sec-WebSocket-Protocol` for typed frames; the frames are described in the AsyncAPI document. An offer of a subprotocol this Worker does not serve is a `validation/invalid_input` 400.",
        verification: ["bearer", "session"],
        responses: {
          101: {
            description:
              'Switches to a WebSocket, answering `Sec-WebSocket-Protocol` with the version chosen. The server sends the caller\'s view of the session as a `state` frame on connect and after every change; the client sends `{ "type": "action", "payload": … }` to act, or `{ "type": "state" }` to resync. An error arrives as an `error` frame, not a closed socket.',
          },
        },
      }),
      requireAuth(),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        negotiateSubprotocol(c.req.raw.headers.get(SUBPROTOCOL_HEADER), MULTIPLAYER_SOCKET_VERSIONS);
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const forwarded = new Request(c.req.raw);
        forwarded.headers.set(USER_HEADER, userId(c));
        return stub.fetch(forwarded) as unknown as Response;
      },
    );

    // Registered last so `/sessions/:id/*` static suffixes above are matched first.
    app.get(
      `${base}/sessions/:id`,
      describeRoute({
        summary: "Read the caller's view of a session.",
        description: "Only a current member may read it; anyone else is `multiplayer/not_a_member`, as on the socket.",
        verification: ["bearer", "session"],
        responses: { 200: SessionView },
      }),
      requireAuth(),
      validate("param", MultiplayerSessionParams),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const view = await callSession(() => stub.view(userId(c)));
        return c.json(view, 200);
      },
    );
  };
}
