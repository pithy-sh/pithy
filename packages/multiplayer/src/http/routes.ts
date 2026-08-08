// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DurableObjectNamespace, DurableObjectStub } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ErrorPayload } from "@pithy-sh/core/src/error/payload";
import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { type ResolvedGame, resolveGame } from "../config/config";
import { MultiplayerGameNotFoundError, MultiplayerSessionNotFoundError } from "../error/errors";
// Type-only, so it erases: the DO module imports `cloudflare:workers` and must never land on the value
// import graph the adopter's `pithy.config.ts` pulls in. The two constants both sides need live in the
// pure `session/protocol` module for the same reason (#172).
import type { MultiplayerSession } from "../session/durableObject";
import { RPC_ERROR_PREFIX, USER_HEADER } from "../session/protocol";
import type { GameSnapshot } from "../session/state";
import { requireAuth } from "./guard";
import { MultiplayerGameParams, MultiplayerSessionParams } from "./schemas";

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
 * forwards its JSON body untouched to the model, which is the only thing that knows its shape. There is no
 * shape for this capability to impose, and a `zValidator("json", …)` would still change what a caller may
 * send: it rejects an empty body under a JSON content-type with a 400, where a body-less action legitimately
 * reaches a model that takes no payload today. So the body is read off the raw request instead, with
 * the same "unreadable body means no payload" fallback — the model, not multiplayer, decides what is legal.
 * The join, leave, and close routes read no body at all, so validating one on them would only 400 the
 * body-less request their clients already send.
 *
 * The authenticated user id comes from the core `AuthContext` seam (`c.var.auth.userId`) and is passed to the
 * Durable Object on every call — the DO never trusts a client-supplied id. The WebSocket upgrade is forwarded
 * to the DO with that id set on {@link USER_HEADER}, a server-set header the DO trusts.
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

/**
 * Run a Durable Object RPC call, reviving a `PithyError` the DO threw.
 *
 * A `PithyError` thrown inside a DO does not cross the RPC boundary as itself — the runtime strips it to a
 * bare Error. So the DO's `guard` encodes the payload as JSON into the Error message behind
 * {@link RPC_ERROR_PREFIX} (a message is the one thing the boundary preserves), and this decodes it back
 * into a real `PithyError` so `pithyErrorHandler` maps it to the same status and body a direct throw would
 * — a `not_a_member` commit stays a 403, not a 500. Anything else propagates untouched (and 500s, correctly).
 */
async function callSession<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PithyError) throw error;
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.startsWith(RPC_ERROR_PREFIX)) {
      try {
        const parsed = ErrorPayload.safeParse(JSON.parse(message.slice(RPC_ERROR_PREFIX.length)));
        if (parsed.success) throw new PithyError(parsed.data, { cause: error });
      } catch (reviveError) {
        // A revived PithyError is the intended result — rethrow it. Only a genuinely malformed envelope
        // (JSON.parse failure) falls through to the original error below, rather than a 500 from here.
        if (reviveError instanceof PithyError) throw reviveError;
      }
    }
    throw error;
  }
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

export function registerMultiplayerRoutes(options: MultiplayerRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/multiplayer";
  const { games } = options;

  return (app) => {
    // Create a session for a configured game. The creator is its first member.
    app.post(
      `${base}/games/:game`,
      requireAuth(),
      zValidator("param", MultiplayerGameParams, validationHook),
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
      requireAuth(),
      zValidator("param", MultiplayerSessionParams, validationHook),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const view = await callSession(() => stub.join(userId(c)));
        return c.json(view, 200);
      },
    );

    app.post(
      `${base}/sessions/:id/action`,
      requireAuth(),
      zValidator("param", MultiplayerSessionParams, validationHook),
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
      requireAuth(),
      zValidator("param", MultiplayerSessionParams, validationHook),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        return c.json(await callSession(() => stub.leave(userId(c))), 200);
      },
    );

    app.post(
      `${base}/sessions/:id/close`,
      requireAuth(),
      zValidator("param", MultiplayerSessionParams, validationHook),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        return c.json(await callSession(() => stub.close(userId(c))), 200);
      },
    );

    app.get(
      `${base}/sessions/:id/result`,
      requireAuth(),
      zValidator("param", MultiplayerSessionParams, validationHook),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const result = await callSession(() => stub.result());
        if (!result) throw new MultiplayerSessionNotFoundError({ detail: "The session has no terminal result yet." });
        return c.json(result, 200);
      },
    );

    // The WebSocket upgrade — forwarded to the DO with the authenticated id set on the trusted header. The
    // DO answers a non-upgrade request with 426, so the check lives there, once.
    app.get(
      `${base}/sessions/:id/socket`,
      requireAuth(),
      zValidator("param", MultiplayerSessionParams, validationHook),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const forwarded = new Request(c.req.raw);
        forwarded.headers.set(USER_HEADER, userId(c));
        return stub.fetch(forwarded) as unknown as Response;
      },
    );

    // Registered last so `/sessions/:id/*` static suffixes above are matched first.
    app.get(
      `${base}/sessions/:id`,
      requireAuth(),
      zValidator("param", MultiplayerSessionParams, validationHook),
      async (c) => {
        const stub = sessionStub(sessionsBinding(c), c.req.valid("param").id);
        const view = await callSession(() => stub.view(userId(c)));
        return c.json(view, 200);
      },
    );
  };
}
