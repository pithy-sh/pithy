// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { DurableObject } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { clientError } from "@pithy-sh/core/src/error/client";
import {
  fromZodError,
  InternalError,
  messageOf,
  PithyError,
  ValidationError,
} from "@pithy-sh/core/src/error/pithyError";
import { negotiateSubprotocol, SUBPROTOCOL_HEADER } from "@pithy-sh/core/src/http/subprotocol";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import type { MultiplayerResult } from "../data/result";
import { resultStore } from "../data/store";
import { multiplayerDatabase } from "../data/tables";
import "../game/builtins";
import {
  MultiplayerGameNotFoundError,
  MultiplayerInvalidTransitionError,
  MultiplayerNotAMemberError,
  MultiplayerSessionFullError,
  MultiplayerSessionNotFoundError,
} from "../error/errors";
import { applyLedgerEffects } from "../game/effects";
import { type GameContext, type GameModel, resolveModel } from "../game/model";
import { createRngState, type RandomSource, randomSource } from "../game/random";
import { ClientFrame, encodeErrorFrame, encodeStateFrame, MULTIPLAYER_SOCKET_VERSIONS } from "./frames";
import { multiplayerPeers } from "./peers";
import { RPC_ERROR_PREFIX, USER_HEADER } from "./protocol";
import { everJoined, type GameSnapshot, isTerminal, SessionMeta, SocketAttachment } from "./state";
import type { SessionOutcome, SessionView } from "./view";

/** The Worker env a session DO reads — the app `DB` database it writes its terminal result to. */
export interface MultiplayerSessionEnv {
  DB: D1Database;
}

const META_KEY = "meta";
const OUTCOME_KEY = "outcome";
const MODEL_STATE_KEY = "modelState";

/**
 * Any publish failure as a `PithyError`, so the log record carries a typed payload — code, message, and the
 * cause text in `detail` — instead of a stringified throw. A `PithyError` from the leaderboard keeps its own
 * code; a bare D1 error (a missing table, a busy database) has no meaningful public code, so it becomes
 * `core/internal` (CLAUDE.md §Errors).
 */
function publishFailure(error: unknown): PithyError {
  if (error instanceof PithyError) return error;
  return new InternalError({ message: "The leaderboard publish failed.", detail: messageOf(error) }, { cause: error });
}

/**
 * One error, as a frame on a player's socket. Every error the socket sends is built here, and the payload
 * goes through core's `clientError` — the same projection the HTTP codec encodes through, because a socket
 * carries the error to the same browser an HTTP body would. `action` and `detail` are an operator's, and
 * this transport has no operator on the other end of it.
 *
 * A `PithyError` is required rather than a loose shape on purpose: the frame cannot be hand-written, so
 * there is no second definition of what a client may read (#344).
 */
function errorFrame(error: PithyError): string {
  return encodeErrorFrame(clientError(error.payload));
}

/** A socket's attachment, read through its schema; null for a socket that carries none or a corrupt one. */
function attachmentOf(ws: WebSocket): SocketAttachment | null {
  const parsed = SocketAttachment.safeParse(ws.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

/**
 * One authoritative game session — Pithy's first Durable Object, and entirely game-agnostic.
 *
 * The session owns everything a relay cannot: membership bound to an authenticated user id (never
 * client-asserted), a lifecycle, hidden per-player state, an alarm-driven deadline, a durable D1 result, and
 * a one-way leaderboard publish. What a *game* is — how a move validates, how state advances, when it ends,
 * who wins, and what each player may see — lives entirely behind a {@link GameModel} resolved from the
 * registry by the game's `kind`. Swapping `commit-reveal` for `sequential`, or an adopter's own model,
 * changes nothing in this object.
 *
 * Platform discipline (the acceptance criteria): the WebSocket Hibernation API only (never `ws.accept()`);
 * no timers (the deadline is an alarm at an absolute ms-epoch time); in-memory state reset on wake (every
 * handler reads storage fresh); and idempotent terminal transitions (a retry re-reads a terminal phase and
 * no-ops; the D1 write is a no-op on conflict).
 */
export class MultiplayerSession extends DurableObject<MultiplayerSessionEnv> {
  /**
   * The session's own logger. `c.var.log` belongs to a `fetch` — a DO method called over RPC, and an alarm
   * that fires with no caller at all, have no request to take one from — so the object builds its own, the
   * way the support inbound handler does. The name scopes every record to this capability.
   */
  private readonly log: Logger = createWorkerLogger({ name: "multiplayer:session" });

  /** The DO's own id is the session id — stable, unguessable, and the D1 result's natural key. */
  private get sessionId(): string {
    return this.ctx.id.toString();
  }

  private async loadMeta(): Promise<SessionMeta | undefined> {
    const raw = await this.ctx.storage.get(META_KEY);
    return raw === undefined ? undefined : SessionMeta.parse(raw);
  }

  private async loadOutcome(): Promise<SessionOutcome | null> {
    const raw = await this.ctx.storage.get(OUTCOME_KEY);
    return raw === undefined ? null : (raw as SessionOutcome);
  }

  /** Resolve the game's model, or fail if its `kind` isn't registered (a stored game whose model was removed). */
  private model(meta: SessionMeta): GameModel {
    const model = resolveModel(meta.game.kind);
    if (!model) {
      throw new MultiplayerGameNotFoundError({
        detail: `Session ${this.sessionId}: no model for kind "${meta.game.kind}".`,
      });
    }
    return model;
  }

  /**
   * The context a model gets — its validated config, the roster, the clock, and a seeded RNG — plus the
   * `rng` handle the DO reads back to persist the advanced cursor. A model that draws randomness advances
   * the cursor; the caller stores `meta.rng.cursor = rng.spent()` so the stream never repeats.
   */
  private makeContext(
    meta: SessionMeta,
    model: GameModel,
  ): { ctx: GameContext<unknown>; rng: RandomSource & { spent(): number } } {
    const rng = randomSource(meta.rng);
    const ctx: GameContext<unknown> = {
      sessionId: this.sessionId,
      config: model.config.parse(meta.game.rules),
      players: meta.members,
      now: Date.now(),
      random: rng,
    };
    return { ctx, rng };
  }

  /** The persisted model state, validated on read, or undefined before play begins. */
  private async loadModelState(model: GameModel): Promise<unknown> {
    const raw = await this.ctx.storage.get(MODEL_STATE_KEY);
    return raw === undefined ? undefined : model.state.parse(raw);
  }

  /** The redacted view for one player — the only shape that ever leaves the object. */
  private async snapshot(userId: string): Promise<SessionView> {
    const meta = await this.loadMeta();
    if (!meta) throw new MultiplayerSessionNotFoundError({ detail: `Session ${this.sessionId} has no metadata.` });
    const model = this.model(meta);
    const outcome = await this.loadOutcome();
    const modelState = await this.loadModelState(model);
    const terminal = isTerminal(meta.phase);
    const state =
      modelState === undefined ? null : model.redact(this.makeContext(meta, model).ctx, modelState, userId, terminal);
    return {
      sessionId: meta.sessionId,
      gameKey: meta.game.key,
      kind: meta.game.kind,
      phase: meta.phase,
      players: meta.members,
      outcome,
      state,
      // Commit always; reveal the seed only once terminal, so a player can verify every draw after the fact.
      fairness: { seedHash: meta.rng.seedHash, seed: terminal ? meta.rng.seed : null },
    };
  }

  /**
   * The session's metadata, for a caller it admits — and a `not_a_member` 403 for anyone else, judged before
   * anything else about the session is said. The view, an action and a close admit a current member; the
   * result and a leave, with `former`, admit anyone who ever joined. Every RPC and socket frame that names a
   * player goes through here, so a session answers one way however it is asked. The socket upgrade judges
   * the same roster in `fetch`, where the answer is a plain response rather than a thrown error.
   */
  private async memberMeta(userId: string, verb: string, options: { former?: boolean } = {}): Promise<SessionMeta> {
    const meta = await this.loadMeta();
    if (!meta) throw new MultiplayerSessionNotFoundError({ detail: `${verb}: session ${this.sessionId} not found.` });
    const admitted = options.former ? everJoined(meta) : meta.members;
    if (!admitted.includes(userId)) {
      throw new MultiplayerNotAMemberError({
        action: options.former
          ? "Only a player who joined this session can do this."
          : "Only a current member of this session can do this.",
        detail: `${verb}: ${userId} is not ${options.former ? "a player in" : "a member of"} ${this.sessionId}.`,
      });
    }
    return meta;
  }

  /**
   * What a player who already left is answered with: the session's identity and phase, and nothing live.
   * A repeated leave stays idempotent without becoming a way to watch a table the player has left.
   * The outcome stays null even once the session has ended: a former player reads how it ended from `/result`.
   */
  private departedView(meta: SessionMeta): SessionView {
    return {
      sessionId: meta.sessionId,
      gameKey: meta.game.key,
      kind: meta.game.kind,
      phase: meta.phase,
      players: [],
      outcome: null,
      state: null,
      fairness: { seedHash: meta.rng.seedHash, seed: null },
    };
  }

  // --- RPC surface: the authenticated Hono handler calls these, passing the AuthContext user id ---

  /**
   * Run an RPC method body, converting a thrown `PithyError` into a bare Error whose message carries the
   * JSON payload (behind {@link RPC_ERROR_PREFIX}) so it survives the RPC boundary. The route revives it;
   * the WebSocket handler calls the internal `apply*` methods directly and keeps the real `PithyError`.
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PithyError) throw new Error(RPC_ERROR_PREFIX + JSON.stringify(error.payload));
      throw error;
    }
  }

  /** Create the session (RPC entry). */
  async create(game: GameSnapshot, creatorUserId: string): Promise<SessionView> {
    return this.guard(() => this.applyCreate(game, creatorUserId));
  }

  /** Join the session (RPC entry). */
  async join(userId: string): Promise<SessionView> {
    return this.guard(() => this.applyJoin(userId));
  }

  /** Take a game action (RPC entry) — a commit, a move, whatever the game's model defines. */
  async action(userId: string, payload: unknown): Promise<SessionView> {
    return this.guard(() => this.applyAction(userId, payload));
  }

  /** Leave a table seat (RPC entry, table mode). */
  async leave(userId: string): Promise<SessionView> {
    return this.guard(() => this.applyLeave(userId));
  }

  /** Close a table (RPC entry, table mode). */
  async close(userId: string): Promise<SessionView> {
    return this.guard(() => this.applyClose(userId));
  }

  /** The redacted view for the authenticated player, who must be a current member (RPC entry). */
  async view(userId: string): Promise<SessionView> {
    return this.guard(() => this.applyView(userId));
  }

  /**
   * The durable result once the session is terminal, or null while it is still live (RPC entry). Read only
   * by someone who ever joined: the result row names the members at the end, so a player who left a table
   * is admitted by the session's own record instead.
   */
  async result(userId: string): Promise<MultiplayerResult | null> {
    return this.guard(async () => {
      await this.memberMeta(userId, "Result", { former: true });
      return (await resultStore(multiplayerDatabase(this.env.DB)).get(this.sessionId)) ?? null;
    });
  }

  /**
   * The user ids with a live (hibernatable) WebSocket right now — read from each socket's attachment, not
   * memory, so it is correct across hibernation. Presence, and the seam a test uses to prove the Hibernation
   * API is in play.
   */
  connectedUserIds(): string[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => attachmentOf(ws)?.userId)
      .filter((id): id is string => Boolean(id));
  }

  /** The live view, for a current member only. */
  private async applyView(userId: string): Promise<SessionView> {
    await this.memberMeta(userId, "View");
    return this.snapshot(userId);
  }

  /** Create the session. Called once, by the authenticated creator, who becomes its first member. */
  private async applyCreate(game: GameSnapshot, creatorUserId: string): Promise<SessionView> {
    if (await this.loadMeta()) {
      throw new MultiplayerInvalidTransitionError({ detail: `Session ${this.sessionId} already exists.` });
    }
    const meta: SessionMeta = {
      sessionId: this.sessionId,
      game,
      // A table opens for play immediately (the creator takes the first seat); a match waits for its roster.
      phase: game.mode === "table" ? "active" : "open",
      members: [creatorUserId],
      joined: [creatorUserId],
      createdAt: Date.now(),
      deadline: null,
      // Mint the provably-fair seed now and commit its hash, before any player can act.
      rng: await createRngState(),
    };
    if (game.mode === "table") {
      // Initialize the table's model state now, with the creator seated.
      const model = this.model(meta);
      const { ctx, rng } = this.makeContext(meta, model);
      await this.ctx.storage.put(MODEL_STATE_KEY, model.init(ctx));
      meta.rng.cursor = rng.spent();
    }
    await this.ctx.storage.put(META_KEY, meta);
    return this.snapshot(creatorUserId);
  }

  /**
   * Join as the authenticated player. Idempotent for an existing member. When the roster fills, the model's
   * initial state is built, the phase advances to `active`, and — if the game sets a `turnTimeoutMs` — the
   * deadline alarm is armed.
   */
  private async applyJoin(userId: string): Promise<SessionView> {
    const meta = await this.loadMeta();
    if (!meta) throw new MultiplayerSessionNotFoundError({ detail: `Join: session ${this.sessionId} not found.` });
    if (meta.members.includes(userId)) return this.snapshot(userId);
    if (isTerminal(meta.phase)) {
      throw new MultiplayerInvalidTransitionError({ detail: `Join: session ${this.sessionId} is ${meta.phase}.` });
    }
    if (meta.members.length >= meta.game.players) {
      throw new MultiplayerSessionFullError({
        detail: `Join: session ${this.sessionId} already has ${meta.game.players} ${meta.game.mode === "table" ? "seats" : "players"}.`,
      });
    }

    meta.members.push(userId);
    meta.joined = everJoined(meta);
    if (meta.game.mode === "table") {
      // A table is already active; the player takes an open seat and the model deals them in.
      const model = this.model(meta);
      const { ctx, rng } = this.makeContext(meta, model);
      if (model.onJoin) {
        const state = await this.loadModelState(model);
        const seated = model.onJoin(ctx, state, userId);
        await applyLedgerEffects(this.env.DB, seated.effects ?? [], multiplayerPeers().ledger);
        await this.ctx.storage.put(MODEL_STATE_KEY, seated.state);
      }
      meta.rng.cursor = rng.spent();
    } else if (meta.members.length === meta.game.players) {
      // A match's roster just filled — start play.
      const model = this.model(meta);
      const { ctx, rng } = this.makeContext(meta, model);
      const modelState = model.init(ctx);
      meta.rng.cursor = rng.spent(); // persist any randomness init drew (a shuffle, an opening roll)
      await this.ctx.storage.put(MODEL_STATE_KEY, modelState);
      meta.phase = "active";
      if (meta.game.turnTimeoutMs !== null) {
        meta.deadline = Date.now() + meta.game.turnTimeoutMs;
        await this.ctx.storage.setAlarm(meta.deadline);
      }
    }
    await this.ctx.storage.put(META_KEY, meta);
    await this.broadcast();
    return this.snapshot(userId);
  }

  /**
   * Apply the authenticated player's action. Legal only while `active` and only for a member; the game's
   * model validates the action itself (an illegal move never persists). When the model reports the game
   * complete, the session resolves.
   */
  private async applyAction(userId: string, payload: unknown): Promise<SessionView> {
    const meta = await this.memberMeta(userId, "Action");
    if (meta.phase !== "active") {
      const reason = meta.phase === "open" ? "still waiting for players" : `over (${meta.phase})`;
      throw new MultiplayerInvalidTransitionError({
        message: `You can't act — the session is ${reason}.`,
        detail: `Action: session ${this.sessionId} is in phase ${meta.phase}.`,
      });
    }

    const model = this.model(meta);
    const { ctx, rng } = this.makeContext(meta, model);
    const state = await this.loadModelState(model);
    // A model that declares its action's shape has every action checked against it first, so a malformed one
    // is the caller's `validation/invalid_input` — judged after membership and phase, like a validator after
    // its guards. The check is a gate and nothing more: `apply` gets the payload as it was sent, never the
    // parsed output. Every `apply` parses its own input, and a schema with a transform produces an output
    // that is not valid input again, so handing it the output would refuse a legal move.
    if (model.action) {
      const parsed = model.action.safeParse(payload);
      if (!parsed.success) {
        throw fromZodError(parsed.error, {
          message: "That action is not one this game accepts.",
          detail: `Action: ${userId} sent a malformed ${meta.game.kind} action to ${this.sessionId}.`,
        });
      }
    }
    const { state: next, effects } = model.apply(ctx, state, userId, payload);

    // Settle the action's ledger effects (a bet's hold) BEFORE committing the new state: a hold the player
    // cannot cover throws here, so the action is rejected and the game state never advances.
    await applyLedgerEffects(this.env.DB, effects ?? [], multiplayerPeers().ledger);
    await this.ctx.storage.put(MODEL_STATE_KEY, next);
    meta.rng.cursor = rng.spent(); // persist any randomness the action drew (a dice roll, a card draw)

    // A match ends when the model reports the game complete. A table never ends on a completed round — the
    // model loops rounds internally and settles each via effects; the table ends only on close or empty.
    if (meta.game.mode === "match" && model.isComplete(ctx, next)) {
      const resolved = model.resolve(ctx, next);
      await applyLedgerEffects(this.env.DB, resolved.effects ?? [], multiplayerPeers().ledger); // final payouts
      // resolve persists meta (with the advanced cursor) as it commits the terminal state.
      await this.resolve(meta, resolved.outcome);
    } else {
      await this.ctx.storage.put(META_KEY, meta);
    }
    await this.broadcast();
    return this.snapshot(userId);
  }

  /**
   * Leave a table seat (table mode only). The model settles the leaver out (releasing their open holds via
   * effects) and their sockets close; when the last player leaves, the table closes. A player who already
   * left gets the departed view, never the live one, and anyone who never joined a `not_a_member` 403.
   */
  private async applyLeave(userId: string): Promise<SessionView> {
    const meta = await this.memberMeta(userId, "Leave", { former: true });
    if (meta.game.mode !== "table") {
      throw new MultiplayerInvalidTransitionError({
        message: "You can only leave a table.",
        detail: `Leave on a ${meta.game.mode} session.`,
      });
    }
    if (!meta.members.includes(userId)) return this.departedView(meta);
    if (isTerminal(meta.phase)) return this.snapshot(userId);

    // Record everyone before the leaver drops out of `members`: a session from before the record existed
    // has none, and this is the last moment it can still name them.
    meta.joined = everJoined(meta);
    meta.members = meta.members.filter((member) => member !== userId);
    const model = this.model(meta);
    const { ctx, rng } = this.makeContext(meta, model); // ctx.players already excludes the leaver
    if (model.onLeave) {
      const state = await this.loadModelState(model);
      const settled = model.onLeave(ctx, state, userId);
      await applyLedgerEffects(this.env.DB, settled.effects ?? [], multiplayerPeers().ledger);
      await this.ctx.storage.put(MODEL_STATE_KEY, settled.state);
    }
    meta.rng.cursor = rng.spent();

    if (meta.members.length === 0) {
      await this.commitTerminal(meta, {
        status: "resolved",
        scores: null,
        winnerUserId: null,
        draw: false,
        resolvedAt: Date.now(),
      });
    } else {
      await this.ctx.storage.put(META_KEY, meta);
    }
    // The leaver is no longer a member, so their sockets go with the seat; broadcast skips them regardless.
    for (const ws of this.ctx.getWebSockets(userId)) {
      try {
        ws.close(1000, "You left the table.");
      } catch {
        // Already closing — ignore.
      }
    }
    await this.broadcast();
    return this.snapshot(userId);
  }

  /** Close a table (table mode only), ending the session. Idempotent once terminal. */
  private async applyClose(userId: string): Promise<SessionView> {
    const meta = await this.memberMeta(userId, "Close");
    if (meta.game.mode !== "table") {
      throw new MultiplayerInvalidTransitionError({
        message: "You can only close a table.",
        detail: `Close on a ${meta.game.mode} session.`,
      });
    }
    if (isTerminal(meta.phase)) return this.snapshot(userId);
    await this.commitTerminal(meta, {
      status: "resolved",
      scores: null,
      winnerUserId: null,
      draw: false,
      resolvedAt: Date.now(),
    });
    await this.broadcast();
    return this.snapshot(userId);
  }

  // --- Resolution and abandonment: the terminal transitions, both idempotent ---

  /** Resolve a complete game: persist the outcome (result-first), then publish to the leaderboard (best-effort). */
  private async resolve(
    meta: SessionMeta,
    outcome: { scores: Record<string, number>; winnerUserId: string | null; draw: boolean },
  ): Promise<void> {
    if (isTerminal(meta.phase)) return;
    const resolved: SessionOutcome = { status: "resolved", ...outcome, resolvedAt: Date.now() };
    await this.commitTerminal(meta, resolved);
    // Best-effort, and last: a leaderboard publish must never fail the action that resolved the game, the
    // same way the audit-emit seam is non-fatal by contract (CLAUDE.md §Security).
    await this.publishResult(meta, resolved);
  }

  /** Abandon a session whose action deadline passed. Terminal, unscored, idempotent. */
  private async abandon(meta: SessionMeta): Promise<void> {
    if (isTerminal(meta.phase)) return;
    await this.commitTerminal(meta, {
      status: "abandoned",
      scores: null,
      winnerUserId: null,
      draw: false,
      resolvedAt: Date.now(),
    });
  }

  /**
   * Persist a terminal outcome, durable-result-first: the D1 write (idempotent on `sessionId`) comes before
   * the phase flips to terminal, so a transient D1 failure leaves the session live and retryable rather than
   * a `resolved` session with no recoverable result row.
   */
  private async commitTerminal(meta: SessionMeta, outcome: SessionOutcome): Promise<void> {
    await this.writeResult(meta, outcome);
    meta.phase = outcome.status;
    meta.deadline = null;
    await this.ctx.storage.put(META_KEY, meta);
    await this.ctx.storage.put(OUTCOME_KEY, outcome);
    await this.ctx.storage.deleteAlarm();
  }

  /** Write the terminal result to D1 — idempotent on sessionId, so a retry never duplicates it. */
  private async writeResult(meta: SessionMeta, outcome: SessionOutcome): Promise<void> {
    await resultStore(multiplayerDatabase(this.env.DB)).write({
      id: 0,
      sessionId: meta.sessionId,
      gameKey: meta.game.key,
      status: outcome.status,
      players: meta.members,
      scores: outcome.scores,
      winnerUserId: outcome.winnerUserId,
      draw: outcome.draw,
      createdAt: new Date(meta.createdAt),
      resolvedAt: new Date(outcome.resolvedAt),
    });
  }

  /**
   * Publish a resolved result to the leaderboard, one-way and best-effort — only when the game configured a
   * board. Through the surface the composition handed over, so `@pithy-sh/leaderboard` stays an optional peer
   * nothing here imports (#645).
   */
  private async publishResult(meta: SessionMeta, outcome: SessionOutcome): Promise<void> {
    const leaderboard = meta.game.leaderboard;
    if (!leaderboard || outcome.status !== "resolved" || outcome.scores === null) return;
    try {
      const { publishResultToLeaderboard } = await import("../publish/leaderboard");
      await publishResultToLeaderboard(
        this.env.DB,
        leaderboard,
        {
          members: meta.members,
          winnerUserId: outcome.winnerUserId,
          draw: outcome.draw,
          at: new Date(outcome.resolvedAt),
        },
        multiplayerPeers().leaderboard,
      );
    } catch (error) {
      // A board misconfigured (or no leaderboard composed) must not fail a resolved session. The result is
      // already durable in D1; only the leaderboard entry is lost. Lost, and never retried — so this is a
      // failure someone has to see and fix, not a degraded path that heals itself. It logs at `error`, and
      // this record is the only trace it ever happened.
      this.log.error("leaderboard publish failed", {
        session: meta.sessionId,
        board: leaderboard.board,
        error: publishFailure(error),
      });
    }
  }

  // --- Alarm: the action deadline. Single persisted schedule, absolute ms-epoch, idempotent handler ---

  override async alarm(): Promise<void> {
    const meta = await this.loadMeta();
    // Idempotent: a terminal session (or one with no armed deadline) is a no-op. Cloudflare fires an alarm
    // only at or after its scheduled time, so reaching here means the deadline has passed.
    if (!meta || isTerminal(meta.phase) || meta.deadline === null) return;
    const model = this.model(meta);
    const { ctx } = this.makeContext(meta, model);
    const state = await this.loadModelState(model);
    if (state !== undefined && model.isComplete(ctx, state)) {
      // The final action raced the deadline and won — resolve rather than abandon.
      const resolved = model.resolve(ctx, state);
      await applyLedgerEffects(this.env.DB, resolved.effects ?? [], multiplayerPeers().ledger);
      await this.resolve(meta, resolved.outcome);
    } else {
      await this.abandon(meta);
    }
    await this.broadcast();
  }

  // --- WebSocket surface: hibernation-safe live play ---

  /**
   * Accept a member's WebSocket via the Hibernation API. The upgrade is forwarded by the authenticated Hono
   * handler, which sets {@link USER_HEADER} to the AuthContext user id — the DO trusts that server-set header
   * and never a client-supplied id. The identity and the negotiated subprotocol are stashed with
   * `serializeAttachment` so they survive hibernation.
   *
   * The subprotocol is negotiated before anything else is judged: an offer this socket does not serve is a
   * 400 with the ordinary JSON error body, and a chosen one is echoed on the 101 — a browser drops a socket
   * whose answer does not name a protocol it offered.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    let protocol: string | null;
    try {
      protocol = negotiateSubprotocol(request.headers.get(SUBPROTOCOL_HEADER), MULTIPLAYER_SOCKET_VERSIONS);
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      return Response.json({ error: clientError(error.payload) }, { status: error.payload.status });
    }
    const userId = request.headers.get(USER_HEADER);
    if (!userId) return new Response("Missing authenticated user.", { status: 401 });

    const meta = await this.loadMeta();
    if (!meta) return new Response("No such session.", { status: 404 });
    if (!meta.members.includes(userId)) return new Response("Not a member of this session.", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation API — never `server.accept()`, which would pin the object in memory.
    this.ctx.acceptWebSocket(server, [userId]);
    // Tiny attachment, well under the 16,384-byte ceiling — the reconnection/resume identity and its version.
    server.serializeAttachment({ userId, sessionId: this.sessionId, protocol } satisfies SocketAttachment);
    server.send(encodeStateFrame(await this.snapshot(userId), protocol));
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(protocol === null ? {} : { headers: { [SUBPROTOCOL_HEADER]: protocol } }),
    });
  }

  /**
   * One frame from a member, parsed with {@link ClientFrame}. Anything that is not JSON is answered with a
   * `validation/invalid_input` error frame on every version, and the socket stays open. A frame that is JSON
   * but not one {@link ClientFrame} accepts depends on the version: a `pithy.multiplayer.v1` socket gets the
   * same error frame, and an unversioned one hears nothing, exactly as before versions existed.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(ws);
    if (!attachment) {
      ws.send(errorFrame(new MultiplayerNotAMemberError({ message: "Unidentified socket." })));
      return;
    }
    const { userId, protocol } = attachment;
    let raw: unknown;
    try {
      raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch (error) {
      ws.send(errorFrame(new ValidationError({ message: "Message must be JSON.", detail: messageOf(error) })));
      return;
    }
    const parsed = ClientFrame.safeParse(raw);
    if (!parsed.success) {
      // The unversioned protocol ignored a frame whose `type` it did not know, or that had none, and a client
      // written against it may lean on that. `ClientFrame` refuses nothing else: an `action` frame's payload
      // is any value and its other keys are dropped, so this is that case and only that one.
      if (protocol === null) return;
      ws.send(
        errorFrame(
          fromZodError(parsed.error, {
            message: "That frame is not one this socket accepts.",
            detail: `Socket frame from ${userId} on ${this.sessionId} failed ClientFrame.`,
          }),
        ),
      );
      return;
    }
    const frame = parsed.data;

    try {
      if (frame.type === "action") {
        // Call the internal method directly — no RPC boundary here, so it throws a real PithyError.
        await this.applyAction(userId, frame.payload);
      } else {
        ws.send(encodeStateFrame(await this.applyView(userId), protocol));
      }
    } catch (error) {
      ws.send(
        errorFrame(
          error instanceof PithyError
            ? error
            : new InternalError({ message: "Something went wrong.", detail: messageOf(error) }, { cause: error }),
        ),
      );
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // The attachment is lost on close; a reconnecting player re-upgrades and gets a fresh snapshot. Nothing
    // authoritative lives on the socket, so there is nothing to persist here.
    try {
      ws.close();
    } catch {
      // Already closing — ignore.
    }
  }

  /**
   * Push each connected member their own redacted view — after any state change. A socket whose user is no
   * longer a member gets nothing: leaving closes it, and this holds even when the close did not land.
   */
  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const members = (await this.loadMeta())?.members ?? [];
    for (const ws of sockets) {
      const attachment = attachmentOf(ws);
      if (!attachment || !members.includes(attachment.userId)) continue;
      try {
        ws.send(encodeStateFrame(await this.snapshot(attachment.userId), attachment.protocol));
      } catch {
        // A dead socket — skip it; the next message or reconnect will resync.
      }
    }
  }
}
