import { DurableObject } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
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
import { applyWalletEffects } from "../game/effects";
import { type GameContext, type GameModel, resolveModel } from "../game/model";
import { createRngState, type RandomSource, randomSource } from "../game/random";
import { type GameSnapshot, isTerminal, SessionMeta, type SessionOutcome, type SessionView } from "./state";

/** The Worker env a session DO reads — the app `DB` database it writes its terminal result to. */
export interface MultiplayerSessionEnv {
  DB: D1Database;
}

/** The header the authenticated Hono handler sets when forwarding a WebSocket upgrade to the DO. */
export const USER_HEADER = "x-pithy-user-id";

/**
 * Marks an Error whose message carries a JSON-encoded `ErrorPayload`. A `PithyError` thrown inside a DO does
 * not survive the RPC boundary — the runtime strips a custom Error subclass down to a bare Error, but a
 * plain Error's **message** is preserved. So `guard` encodes the payload into the message behind this
 * sentinel, and `callSession` in the routes decodes it back into a real `PithyError`.
 */
export const RPC_ERROR_PREFIX = "pithy-error:";

const META_KEY = "meta";
const OUTCOME_KEY = "outcome";
const MODEL_STATE_KEY = "modelState";

/** A message a client sends over the WebSocket — take an action, or ask for the current state. */
interface ClientMessage {
  type: "action" | "state";
  payload?: unknown;
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

  /** The redacted view for the authenticated player (RPC entry). */
  async view(userId: string): Promise<SessionView> {
    return this.guard(() => this.snapshot(userId));
  }

  /** The durable result once the session is terminal, or null while it is still live. */
  async result(): Promise<MultiplayerResult | null> {
    return (await resultStore(multiplayerDatabase(this.env.DB)).get(this.sessionId)) ?? null;
  }

  /**
   * The user ids with a live (hibernatable) WebSocket right now — read from each socket's attachment, not
   * memory, so it is correct across hibernation. Presence, and the seam a test uses to prove the Hibernation
   * API is in play.
   */
  connectedUserIds(): string[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => (ws.deserializeAttachment() as { userId?: string } | null)?.userId)
      .filter((id): id is string => Boolean(id));
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
    if (meta.game.mode === "table") {
      // A table is already active; the player takes an open seat and the model deals them in.
      const model = this.model(meta);
      const { ctx, rng } = this.makeContext(meta, model);
      if (model.onJoin) {
        const state = await this.loadModelState(model);
        const seated = model.onJoin(ctx, state, userId);
        await applyWalletEffects(this.env.DB, seated.effects ?? []);
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
    const meta = await this.loadMeta();
    if (!meta) throw new MultiplayerSessionNotFoundError({ detail: `Action: session ${this.sessionId} not found.` });
    if (!meta.members.includes(userId)) {
      throw new MultiplayerNotAMemberError({ detail: `Action: ${userId} is not a member of ${this.sessionId}.` });
    }
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
    const { state: next, effects } = model.apply(ctx, state, userId, payload);

    // Settle the action's wallet effects (a bet's hold) BEFORE committing the new state: a hold the player
    // cannot cover throws here, so the action is rejected and the game state never advances.
    await applyWalletEffects(this.env.DB, effects ?? []);
    await this.ctx.storage.put(MODEL_STATE_KEY, next);
    meta.rng.cursor = rng.spent(); // persist any randomness the action drew (a dice roll, a card draw)

    // A match ends when the model reports the game complete. A table never ends on a completed round — the
    // model loops rounds internally and settles each via effects; the table ends only on close or empty.
    if (meta.game.mode === "match" && model.isComplete(ctx, next)) {
      const resolved = model.resolve(ctx, next);
      await applyWalletEffects(this.env.DB, resolved.effects ?? []); // final payouts
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
   * effects); when the last player leaves, the table closes. Idempotent for a non-member.
   */
  private async applyLeave(userId: string): Promise<SessionView> {
    const meta = await this.loadMeta();
    if (!meta) throw new MultiplayerSessionNotFoundError({ detail: `Leave: session ${this.sessionId} not found.` });
    if (meta.game.mode !== "table") {
      throw new MultiplayerInvalidTransitionError({
        message: "You can only leave a table.",
        detail: `Leave on a ${meta.game.mode} session.`,
      });
    }
    if (isTerminal(meta.phase) || !meta.members.includes(userId)) return this.snapshot(userId);

    meta.members = meta.members.filter((member) => member !== userId);
    const model = this.model(meta);
    const { ctx, rng } = this.makeContext(meta, model); // ctx.players already excludes the leaver
    if (model.onLeave) {
      const state = await this.loadModelState(model);
      const settled = model.onLeave(ctx, state, userId);
      await applyWalletEffects(this.env.DB, settled.effects ?? []);
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
    await this.broadcast();
    return this.snapshot(userId);
  }

  /** Close a table (table mode only), ending the session. Idempotent once terminal. */
  private async applyClose(userId: string): Promise<SessionView> {
    const meta = await this.loadMeta();
    if (!meta) throw new MultiplayerSessionNotFoundError({ detail: `Close: session ${this.sessionId} not found.` });
    if (meta.game.mode !== "table") {
      throw new MultiplayerInvalidTransitionError({
        message: "You can only close a table.",
        detail: `Close on a ${meta.game.mode} session.`,
      });
    }
    if (!meta.members.includes(userId)) {
      throw new MultiplayerNotAMemberError({ detail: `Close: ${userId} is not at table ${this.sessionId}.` });
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
   * board. Loaded by dynamic import so `@pithy-sh/leaderboard` stays an optional peer.
   */
  private async publishResult(meta: SessionMeta, outcome: SessionOutcome): Promise<void> {
    const leaderboard = meta.game.leaderboard;
    if (!leaderboard || outcome.status !== "resolved" || outcome.scores === null) return;
    try {
      const { publishResultToLeaderboard } = await import("../publish/leaderboard");
      await publishResultToLeaderboard(this.env.DB, leaderboard, {
        members: meta.members,
        winnerUserId: outcome.winnerUserId,
        draw: outcome.draw,
        at: new Date(outcome.resolvedAt),
      });
    } catch (error) {
      // A board misconfigured (or leaderboard not installed) must not fail a resolved session. The result is
      // already durable in D1; only the leaderboard entry is lost.
      console.error(`multiplayer: leaderboard publish failed for session ${meta.sessionId}`, error);
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
      await applyWalletEffects(this.env.DB, resolved.effects ?? []);
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
   * and never a client-supplied id. The identity is stashed with `serializeAttachment` so it survives
   * hibernation.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
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
    // Tiny attachment, well under the 16,384-byte ceiling — the reconnection/resume identity.
    server.serializeAttachment({ userId, sessionId: this.sessionId });
    server.send(JSON.stringify(await this.snapshot(userId)));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as { userId?: string } | null;
    const userId = attachment?.userId;
    if (!userId) {
      ws.send(
        JSON.stringify({ type: "error", error: { code: "multiplayer/not_a_member", message: "Unidentified socket." } }),
      );
      return;
    }
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as ClientMessage;
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          error: { code: "validation/invalid_input", message: "Message must be JSON." },
        }),
      );
      return;
    }

    try {
      if (parsed.type === "action") {
        // Call the internal method directly — no RPC boundary here, so it throws a real PithyError.
        await this.applyAction(userId, parsed.payload);
      } else if (parsed.type === "state") {
        ws.send(JSON.stringify(await this.snapshot(userId)));
      }
    } catch (error) {
      // Never leak `detail` to a client — send only the public projection, the same boundary the HTTP codec holds.
      const payload =
        error instanceof PithyError
          ? { code: error.payload.code, message: error.payload.message, action: error.payload.action }
          : { code: "core/internal", message: "Something went wrong." };
      ws.send(JSON.stringify({ type: "error", error: payload }));
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

  /** Push each connected member their own redacted view — after any state change. */
  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as { userId?: string } | null;
      if (!attachment?.userId) continue;
      try {
        ws.send(JSON.stringify(await this.snapshot(attachment.userId)));
      } catch {
        // A dead socket — skip it; the next message or reconnect will resync.
      }
    }
  }
}
