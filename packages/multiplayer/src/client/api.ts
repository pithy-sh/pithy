// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The client half of `@pithy-sh/multiplayer`'s HTTP routes: start a session, join it, act in it, leave or
 * close a table, and read a session or how it ended — from a web app the Worker itself serves.
 *
 * **It is for that web app and nothing else.** Every request goes to a rooted, same-origin path, so it rides
 * the page's own origin and its session cookie, and a `basePath` naming another host is refused. A mobile app,
 * a game engine, or anything else off the Worker's origin has no such path to call: it generates its client
 * from the `openapi.json` (these routes) and `asyncapi.json` (the live socket) that `pithy contract` writes
 * for the Worker.
 *
 * **It exists for the reason `@pithy-sh/organization`'s counterpart does.** A request spelled out inside an
 * app is frozen at the moment it was written, and a later fix to the base path or the failure wording reaches
 * none of them. The calls live here and upgrade with a release.
 *
 * **Nothing here imports anything, and that is structural rather than tidy.** This module compiles into a
 * client bundle; importing `../http/responses` would drag Zod and the Worker's schema graph in behind it. So
 * the wire shapes are declared literally and narrowed by hand-written guards, and the same-origin rule is a
 * check in {@link callMultiplayer} rather than a convention a caller could forget.
 *
 * **Nothing throws.** With no imports, `PithyError` is not in reach and a bare `throw new Error` is what this
 * kit forbids. An unreachable Worker, a proxy's HTML error page, a 500 — each becomes a renderable
 * {@link MultiplayerFailure}, and every caller answers one. The Worker is the authority on every move; this
 * side of the wire only decides what a screen shows.
 *
 * **Two ways to be verified.** The usual one is the session cookie: every request is sent with
 * `credentials: "include"`. A web app that holds a bearer token instead passes it through
 * {@link MultiplayerClientOptions.headers} — `{ authorization: "Bearer …" }`.
 *
 * The live socket is not here: its frames are Zod schemas in `../session/frames.ts`, and the Worker's
 * `asyncapi.json` describes them.
 */

/** Where the multiplayer routes mount by default — the capability's own default `basePath`. */
export const MULTIPLAYER_BASE_PATH = "/multiplayer";

/**
 * The slice of `fetch`'s init this module uses, declared structurally.
 *
 * Not `typeof fetch`: the package compiles against `@cloudflare/workers-types`, whose `RequestInit` has no
 * `credentials` — and `credentials: "include"` is the entire cookie story.
 */
export interface MultiplayerRequestInit {
  /** The HTTP method. Absent means GET. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** The JSON body, already serialized. */
  body?: string;
  /** Cookie policy. Always `include` here — same-origin, httpOnly session cookie. */
  credentials?: "include" | "same-origin" | "omit";
}

/** The slice of `Response` this module reads. */
export interface MultiplayerResponse {
  /** Whether the status was 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The parsed body, or a rejection when it was not JSON. */
  json(): Promise<unknown>;
}

/** A fetch this module can call. */
export type MultiplayerFetch = (input: string, init?: MultiplayerRequestInit) => Promise<MultiplayerResponse>;

/** The globals this module reaches for, as an injectable seam. */
export interface MultiplayerGlobal {
  /** The program's fetch. */
  fetch?: MultiplayerFetch;
}

/** What every call takes: where the routes are, how the caller is verified, and the seams a test replaces. */
export interface MultiplayerClientOptions {
  /** Where the multiplayer routes mount. Defaults to {@link MULTIPLAYER_BASE_PATH}. */
  basePath?: string;
  /**
   * Headers sent with every request — a bearer client's `authorization`. A web app on the Worker's origin
   * leaves it unset and rides its session cookie.
   */
  headers?: Record<string, string>;
  /** The fetch to use. Defaults to the one on {@link MultiplayerClientOptions.global}. */
  fetch?: MultiplayerFetch;
  /** The global object the default fetch comes off. Defaults to `globalThis`. */
  global?: MultiplayerGlobal;
}

/** A refusal a screen can render: the namespaced code, the public message, and what to do next. */
export interface MultiplayerFailure {
  /** The namespaced code — `multiplayer/not_a_member`, or a `client/*` sentinel this module minted. */
  code: string;
  /** The public message. The server's `detail` never crosses the HTTP codec, so this is all there is. */
  message: string;
  /** What to do next, when this module has something to say. The server never sends one. */
  action: string | null;
}

/** Either the value, or a failure to render. Never a throw. */
export type MultiplayerClientResult<T> = { ok: true; value: T } | { ok: false; failure: MultiplayerFailure };

/** The worker could not be reached at all. Offline, or a DNS failure, or no fetch in this program. */
export const MULTIPLAYER_UNREACHABLE: MultiplayerFailure = {
  code: "client/unreachable",
  message: "We couldn't reach the server.",
  action: "Check your connection, then try again.",
};

/** The worker answered with something this client cannot read. A proxy's HTML page, or a shape change. */
export const MULTIPLAYER_UNREADABLE: MultiplayerFailure = {
  code: "client/unreadable",
  message: "The server answered with something we couldn't read.",
  action: "Try again. If it keeps happening, the app and the backend are out of step.",
};

/**
 * The request would have left this origin, so it was never sent.
 *
 * Reachable only through a `basePath` that is not a rooted same-origin path. Sending it would attach an
 * ambient session to a request this page is not entitled to make.
 */
export const MULTIPLAYER_CROSS_ORIGIN: MultiplayerFailure = {
  code: "client/cross_origin",
  message: "That request would have left this site, so it wasn't sent.",
  action: "Check the multiplayer `basePath` in pithy.config.ts — it is a path on this worker, not a URL.",
};

/** A session's lifecycle phase. `open` and `active` are live; `resolved` and `abandoned` are terminal. */
export type SessionPhase = "open" | "active" | "resolved" | "abandoned";

/** How a terminal session ended, as a session view carries it. */
export interface SessionOutcome {
  /** The terminal state. */
  status: "resolved" | "abandoned";
  /** Each player's score, keyed by user id, or null when abandoned. */
  scores: Record<string, number> | null;
  /** The winner's user id, or null on a draw or abandonment. */
  winnerUserId: string | null;
  /** Whether the session ended level. */
  draw: boolean;
  /** When the session reached its terminal state, ms-epoch. */
  resolvedAt: number;
}

/** One player's view of a session — what every session route answers with. */
export interface SessionView {
  /** The session id. */
  sessionId: string;
  /** The game being played. */
  gameKey: string;
  /** The game model this session uses. */
  kind: string;
  /** The session's current phase. */
  phase: SessionPhase;
  /** Every member's user id, in join order. */
  players: string[];
  /** The result, present only once the session is terminal. */
  outcome: SessionOutcome | null;
  /** The game's own view for this player — its `<gameKey>.view` schema — or null before play begins. */
  state: unknown;
  /** The provably-fair commitment, and once terminal, the seed itself. */
  fairness: { seedHash: string; seed: string | null };
}

/** The durable record of how a finished session ended. */
export interface SessionResult {
  /** The result row's internal id. Address a result by `sessionId`, not this. */
  id: number;
  /** The session this result belongs to. */
  sessionId: string;
  /** The game the session played. */
  gameKey: string;
  /** The terminal state. */
  status: "resolved" | "abandoned";
  /** The members' user ids, in join order. */
  players: string[];
  /** Each player's final score, or null when abandoned. */
  scores: Record<string, number> | null;
  /** The winner's user id, or null on a draw and on an abandoned session. */
  winnerUserId: string | null;
  /** Whether the session ended level. */
  draw: boolean;
  /** When the session was created, ISO-8601. */
  createdAt: string;
  /** When the session reached its terminal state, ISO-8601. */
  resolvedAt: string;
}

/** Whether a value is a plain record — the first step of every guard below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether a value is a list of strings. */
function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Whether a value is null, or a record of numbers keyed by user id. */
function isScores(value: unknown): value is Record<string, number> | null {
  return value === null || (isRecord(value) && Object.values(value).every((score) => typeof score === "number"));
}

/** Whether a value is a terminal status. */
function isTerminalStatus(value: unknown): value is "resolved" | "abandoned" {
  return value === "resolved" || value === "abandoned";
}

/** Whether a value is a phase. */
function isPhase(value: unknown): value is SessionPhase {
  return value === "open" || value === "active" || isTerminalStatus(value);
}

/** Whether a value is a nullable user id. */
function isOptionalUser(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Narrow a session's outcome. */
function isSessionOutcome(value: unknown): value is SessionOutcome {
  if (!isRecord(value)) return false;
  if (!isTerminalStatus(value.status) || !isScores(value.scores) || !isOptionalUser(value.winnerUserId)) return false;
  return typeof value.draw === "boolean" && typeof value.resolvedAt === "number";
}

/** Narrow a session view. `state` is the game's to shape, so it is required only to be present. */
function isSessionView(value: unknown): value is SessionView {
  if (!isRecord(value)) return false;
  if (!isText(value.sessionId) || !isText(value.gameKey) || !isText(value.kind)) return false;
  if (!isPhase(value.phase) || !isTextList(value.players)) return false;
  if (value.outcome !== null && !isSessionOutcome(value.outcome)) return false;
  if (!("state" in value)) return false;
  const fairness = value.fairness;
  if (!isRecord(fairness) || !isText(fairness.seedHash)) return false;
  return fairness.seed === null || typeof fairness.seed === "string";
}

/** Narrow a session's durable result. */
function isSessionResult(value: unknown): value is SessionResult {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "number" || !isText(value.sessionId) || !isText(value.gameKey)) return false;
  if (!isTerminalStatus(value.status) || !isTextList(value.players) || !isScores(value.scores)) return false;
  if (!isOptionalUser(value.winnerUserId) || typeof value.draw !== "boolean") return false;
  return isText(value.createdAt) && isText(value.resolvedAt);
}

/**
 * Whether a composed path stays on this origin.
 *
 * A rooted path and nothing that resolves elsewhere. `//host` and `/\host` are the two forms a URL parser
 * reads as an authority rather than as a path, and a browser follows both.
 */
function isSameOriginPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const second = path.charAt(1);
  return second !== "/" && second !== "\\";
}

/**
 * A failure read off the envelope this Worker answers with, or the generic one when the body is not it.
 * Every route this capability ships answers a refusal through `pithyErrorHandler`, as
 * `{ error: { code, message } }`.
 */
function failureFrom(body: unknown, status: number): MultiplayerFailure {
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    if (isText(error.code) && isText(error.message)) {
      return { code: error.code, message: error.message, action: isText(error.action) ? error.action : null };
    }
  }
  return {
    code: `client/http_${status}`,
    message: MULTIPLAYER_UNREADABLE.message,
    action: MULTIPLAYER_UNREADABLE.action,
  };
}

/**
 * One request to this Worker's multiplayer routes. The one place the transport is written down: a rooted
 * same-origin path, `credentials: "include"`, and any headers the caller verifies with.
 */
async function callMultiplayer(
  path: string,
  init: MultiplayerRequestInit,
  options: MultiplayerClientOptions,
): Promise<MultiplayerClientResult<unknown>> {
  const base = options.basePath ?? MULTIPLAYER_BASE_PATH;
  const url = `${base}${path}`;
  // Checked before the request is built, not after it fails. A `basePath` naming another host would
  // otherwise send this reader's session somewhere they never agreed to.
  if (!isSameOriginPath(url)) return { ok: false, failure: MULTIPLAYER_CROSS_ORIGIN };

  const send = options.fetch ?? (options.global ?? (globalThis as MultiplayerGlobal)).fetch;
  if (!send) return { ok: false, failure: MULTIPLAYER_UNREACHABLE };

  let response: MultiplayerResponse;
  try {
    response = await send(url, {
      ...init,
      headers: { ...options.headers, ...init.headers },
      credentials: "include",
    });
  } catch {
    // Offline, DNS, a refused connection. Nothing to read and nothing to say beyond "try again".
    return { ok: false, failure: MULTIPLAYER_UNREACHABLE };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A proxy's HTML error page, or an empty body on a status that promised one.
    return { ok: false, failure: response.ok ? MULTIPLAYER_UNREADABLE : failureFrom(undefined, response.status) };
  }

  if (!response.ok) return { ok: false, failure: failureFrom(body, response.status) };
  return { ok: true, value: body };
}

/** A session route's answer, narrowed to a view. */
async function sessionCall(
  path: string,
  init: MultiplayerRequestInit,
  options: MultiplayerClientOptions,
): Promise<MultiplayerClientResult<SessionView>> {
  const result = await callMultiplayer(path, init, options);
  if (!result.ok) return result;
  if (!isSessionView(result.value)) return { ok: false, failure: MULTIPLAYER_UNREADABLE };
  return { ok: true, value: result.value };
}

/**
 * One path segment, encoded so a value can never add a segment or a query of its own. A lone surrogate is
 * replaced first: `encodeURIComponent` throws on one, and nothing here throws.
 */
function segment(value: string): string {
  return encodeURIComponent(
    value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"),
  );
}

/** A session's path, its id encoded so it stays one segment. */
function sessionPath(sessionId: string, suffix = ""): string {
  return `/sessions/${segment(sessionId)}${suffix}`;
}

/** Start a session of a configured game. The caller becomes its first member. */
export function createSession(
  gameKey: string,
  options: MultiplayerClientOptions = {},
): Promise<MultiplayerClientResult<SessionView>> {
  return sessionCall(`/games/${segment(gameKey)}`, { method: "POST" }, options);
}

/** Join a session. Joining one you are already in answers your view again. */
export function joinSession(
  sessionId: string,
  options: MultiplayerClientOptions = {},
): Promise<MultiplayerClientResult<SessionView>> {
  return sessionCall(sessionPath(sessionId, "/join"), { method: "POST" }, options);
}

/**
 * Take an action in a session — a move, a commit, a bet — in the shape the game defines, its `<gameKey>.action`
 * schema. Pass `undefined` for a game whose action takes no payload. A shape the game refuses is a
 * `validation/invalid_input` failure, and an illegal move is the game's own refusal.
 */
export function act(
  sessionId: string,
  action: unknown,
  options: MultiplayerClientOptions = {},
): Promise<MultiplayerClientResult<SessionView>> {
  const init: MultiplayerRequestInit =
    action === undefined
      ? { method: "POST" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) };
  return sessionCall(sessionPath(sessionId, "/action"), init, options);
}

/** Leave your seat at a table. Leaving one you are not at answers your view again. */
export function leaveSession(
  sessionId: string,
  options: MultiplayerClientOptions = {},
): Promise<MultiplayerClientResult<SessionView>> {
  return sessionCall(sessionPath(sessionId, "/leave"), { method: "POST" }, options);
}

/** Close a table you are seated at, ending the session. */
export function closeSession(
  sessionId: string,
  options: MultiplayerClientOptions = {},
): Promise<MultiplayerClientResult<SessionView>> {
  return sessionCall(sessionPath(sessionId, "/close"), { method: "POST" }, options);
}

/** Read your view of a session. */
export function readSession(
  sessionId: string,
  options: MultiplayerClientOptions = {},
): Promise<MultiplayerClientResult<SessionView>> {
  return sessionCall(sessionPath(sessionId), { method: "GET" }, options);
}

/** Read how a finished session ended. A session still in play is `multiplayer/session_not_found`. */
export async function readResult(
  sessionId: string,
  options: MultiplayerClientOptions = {},
): Promise<MultiplayerClientResult<SessionResult>> {
  const result = await callMultiplayer(sessionPath(sessionId, "/result"), { method: "GET" }, options);
  if (!result.ok) return result;
  if (!isSessionResult(result.value)) return { ok: false, failure: MULTIPLAYER_UNREADABLE };
  return { ok: true, value: result.value };
}
