// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The client half of `@pithy-sh/leaderboard`: how a web app the Worker serves lists the boards, reads a
 * page of one, finds the player's own rank, and — where the Worker allows it — submits a score.
 *
 * **It is for a web app on the Worker's own origin, and nothing else.** Every call takes a rooted
 * same-origin path — `basePath` must start with `/` — so there is no host to point it at. A React Native
 * app or a game engine is not on that origin and cannot use it: generate its client from the Worker's
 * `openapi.json` instead.
 *
 * **It exists for the reason `@pithy-sh/organization`'s counterpart does.** A request spelled out inside
 * an app is frozen at the moment it was written, and a later fix to a path or a failure's wording reaches
 * none of them. The calls live here and upgrade with a release.
 *
 * **Nothing here imports anything, and that is structural rather than tidy.** This module compiles into a
 * client bundle; importing `../http/responses` would drag the Worker's Zod graph in behind it. So the wire
 * shapes are declared literally and narrowed by hand-written guards, and the same-origin rule is a check
 * in {@link callLeaderboard} rather than a convention a caller could forget.
 *
 * **Nothing throws.** An unreachable Worker, a proxy's HTML error page, a 500 — each becomes a renderable
 * {@link LeaderboardFailure}, and every caller answers one. The Worker is still the security boundary.
 *
 * **The session cookie is the usual credential.** A web app on the Worker's origin rides its session
 * cookie, which `credentials: "include"` sends. One that holds a bearer token instead passes
 * `headers: { authorization: "Bearer …" }` on each call.
 *
 * **Submitting is usually the game server's job, not the player's.** While `serverAuthoritative` is on,
 * which is the default, {@link submitScore} needs a token carrying the submit scope, and a player's own
 * token is refused with `leaderboard/submit_forbidden`.
 */

/** Where the leaderboard routes mount by default — the same default `leaderboard({ basePath })` carries. */
export const LEADERBOARD_BASE_PATH = "/leaderboard";

/** The header a D1 bookmark travels on, both ways. */
export const LEADERBOARD_BOOKMARK_HEADER = "x-pithy-d1-bookmark";

/**
 * The slice of `fetch` this module uses, declared structurally.
 *
 * Not `typeof fetch`: the package compiles against `@cloudflare/workers-types`, whose `RequestInit` has
 * no `credentials` — and `credentials: "include"` is the entire cookie story.
 */
export interface LeaderboardRequestInit {
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
export interface LeaderboardResponse {
  /** Whether the status was 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The response headers, read only for the D1 bookmark. Optional, so a test's fake may leave it out. */
  headers?: { get(name: string): string | null };
  /** The parsed body, or a rejection when it was not JSON. */
  json(): Promise<unknown>;
}

/** A fetch this module can call. */
export type LeaderboardFetch = (input: string, init?: LeaderboardRequestInit) => Promise<LeaderboardResponse>;

/** The globals this module reaches for, as an injectable seam. */
export interface LeaderboardGlobal {
  /** The program's fetch. */
  fetch?: LeaderboardFetch;
}

/**
 * Read-your-own-writes, carried between calls. Pass the same object to a write and the reads after it:
 * each answer's bookmark is kept here and sent on the next request, so a player who submitted a score
 * sees it on the board even while D1 replicas lag. Optional — a client that never passes one still works.
 */
export interface LeaderboardSession {
  /** The newest bookmark the Worker answered with, or null before any. */
  bookmark: string | null;
}

/** What every call takes: where the routes are, how the caller is identified, and the seams a test replaces. */
export interface LeaderboardClientOptions {
  /** Where the leaderboard routes mount. Defaults to {@link LEADERBOARD_BASE_PATH}. */
  basePath?: string;
  /** Extra request headers — a bearer client's `authorization`. A cookie session needs none. */
  headers?: Record<string, string>;
  /** The bookmark carrier for read-your-own-writes. See {@link LeaderboardSession}. */
  session?: LeaderboardSession;
  /** The fetch to use. Defaults to the one on {@link LeaderboardClientOptions.global}. */
  fetch?: LeaderboardFetch;
  /** The global object the default fetch comes off. Defaults to `globalThis`. */
  global?: LeaderboardGlobal;
}

/** A refusal a screen can render: the namespaced code, the public message, and what to do next. */
export interface LeaderboardFailure {
  /** The namespaced code — `leaderboard/board_not_found`, or a `client/*` sentinel this module minted. */
  code: string;
  /** The public message. The server's `detail` never crosses the HTTP codec, so this is all there is. */
  message: string;
  /** What to do next, when the server offered one. */
  action: string | null;
}

/** Either the value, or a failure to render. Never a throw. */
export type LeaderboardResult<T> = { ok: true; value: T } | { ok: false; failure: LeaderboardFailure };

/** The worker could not be reached at all. Offline, or a DNS failure, or no fetch in this program. */
export const LEADERBOARD_UNREACHABLE: LeaderboardFailure = {
  code: "client/unreachable",
  message: "We couldn't reach the server.",
  action: "Check your connection, then try again.",
};

/** The worker answered with something this client cannot read. A proxy's HTML page, or a shape change. */
export const LEADERBOARD_UNREADABLE: LeaderboardFailure = {
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
export const LEADERBOARD_CROSS_ORIGIN: LeaderboardFailure = {
  code: "client/cross_origin",
  message: "That request would have left this site, so it wasn't sent.",
  action: "Check the leaderboard `basePath` in pithy.config.ts — it is a path on this worker, not a URL.",
};

/** One tier of a board. */
export interface BoardTier {
  /** The tier's key. */
  key: string;
  /** The score at which the tier begins, inclusive, read in the board's direction. */
  from: number;
}

/** One configured board. */
export interface BoardSummary {
  /** The board's key. What every other call takes as `board`. */
  key: string;
  /** Where the board's entries live. Always `d1` today. */
  store: string;
  /** `desc` when a higher score ranks first, `asc` when a lower one does. */
  direction: string;
  /** How repeat submissions combine: `best`, `latest` or `sum`. */
  aggregation: string;
  /** The UTC CRON expression marking where each window opens, or null for an all-time board. */
  window: string | null;
  /** The board's tiers, worst to best. Empty when it has none. */
  tiers: BoardTier[];
}

/** One ranked player on a board. */
export interface RankedEntry {
  /** The player's id. */
  userId: string;
  /** The player's score in this window. */
  score: number;
  /** When the score that counts was recorded, ISO-8601. */
  achievedAt: string;
  /** Position on the board, from 1. Ties share a rank. */
  rank: number;
  /** The tier the score falls in, or null when the board has no tiers. */
  tier: string | null;
}

/** A page of ranked entries from one board and window. */
export interface BoardPage {
  /** The board's key. */
  board: string;
  /** The window this page reads: a scheduled window's key, or `all` for an all-time board. */
  window: string;
  /** The entries, best first. */
  entries: RankedEntry[];
}

/** The caller's own standing on a board. */
export interface OwnRank {
  /** The board's key. */
  board: string;
  /** The window read. */
  window: string;
  /** The caller's id. */
  userId: string;
  /** The caller's score in this window. */
  score: number;
  /** The caller's position, from 1, or null while it is not ranked yet. */
  rank: number | null;
  /** The caller's tier, or null when the board has no tiers. */
  tier: string | null;
  /** Whether the caller appears to other players. */
  visible: boolean;
  /** True when `rank` came from the stored column and may lag the score beside it. */
  rankStale: boolean;
}

/** Which window a call reads or writes. Omit `window` for the one open now. */
export interface WindowOptions {
  /** The ISO key of a closed window. */
  window?: string;
}

/** A page of the top of a board. */
export interface TopOptions extends WindowOptions {
  /** How many entries, 1 to 100. The Worker defaults to 20. */
  limit?: number;
  /** How many entries to skip. */
  offset?: number;
}

/** The slice of a board around the caller. */
export interface AroundOptions extends WindowOptions {
  /** How many entries either side of the caller, 1 to 25. The Worker defaults to 5. */
  radius?: number;
}

/** A friends or cohort view of a board. */
export interface SegmentOptions extends TopOptions {
  /** The players to rank among, 1 to 80 of them. */
  userIds: string[];
}

/** Whether a value is a plain record — the first step of every guard below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether a value is a finite number. */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether a composed path stays on this origin.
 *
 * A rooted path and nothing that resolves elsewhere. `//host` and `/\host` are the two forms a URL
 * parser reads as an authority rather than as a path, and a browser follows both.
 */
function isSameOriginPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const second = path.charAt(1);
  return second !== "/" && second !== "\\";
}

/** A failure read off the envelope this Worker answers with, or the generic one when the body is not it. */
function failureFrom(body: unknown, status: number): LeaderboardFailure {
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    if (isText(error.code) && isText(error.message)) {
      return { code: error.code, message: error.message, action: isText(error.action) ? error.action : null };
    }
  }
  return {
    code: `client/http_${status}`,
    message: LEADERBOARD_UNREADABLE.message,
    action: LEADERBOARD_UNREADABLE.action,
  };
}

/**
 * One path segment, encoded so a value can never add a segment or a query of its own. A lone surrogate is
 * replaced first: `encodeURIComponent` throws on one, and nothing here throws.
 */
function segment(value: string): string {
  return encodeURIComponent(
    value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�"),
  );
}

/** A query string from the values that are set, or nothing when none is. */
function query(values: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(values).filter((pair): pair is [string, string | number] => pair[1] !== undefined);
  if (pairs.length === 0) return "";
  return `?${pairs.map(([key, value]) => `${key}=${segment(String(value))}`).join("&")}`;
}

/**
 * One same-origin request to this Worker's leaderboard routes.
 *
 * The one place the transport is written down: `credentials: "include"` for a cookie session, any headers
 * the caller passed for a bearer token, and the session's bookmark both ways.
 */
async function callLeaderboard(
  path: string,
  init: LeaderboardRequestInit,
  options: LeaderboardClientOptions,
): Promise<LeaderboardResult<unknown>> {
  const url = `${options.basePath ?? LEADERBOARD_BASE_PATH}${path}`;
  // Checked before the request is built, not after it fails. A `basePath` naming another host would
  // otherwise send this reader's session somewhere they never agreed to.
  if (!isSameOriginPath(url)) return { ok: false, failure: LEADERBOARD_CROSS_ORIGIN };

  const send = options.fetch ?? (options.global ?? (globalThis as LeaderboardGlobal)).fetch;
  if (!send) return { ok: false, failure: LEADERBOARD_UNREACHABLE };

  const bookmark = options.session?.bookmark;
  let response: LeaderboardResponse;
  try {
    response = await send(url, {
      ...init,
      headers: {
        ...options.headers,
        ...(bookmark ? { [LEADERBOARD_BOOKMARK_HEADER]: bookmark } : {}),
        ...init.headers,
      },
      credentials: "include",
    });
  } catch {
    return { ok: false, failure: LEADERBOARD_UNREACHABLE };
  }

  const next = response.headers?.get(LEADERBOARD_BOOKMARK_HEADER);
  if (options.session && isText(next)) options.session.bookmark = next;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: response.ok ? LEADERBOARD_UNREADABLE : failureFrom(undefined, response.status) };
  }

  if (!response.ok) return { ok: false, failure: failureFrom(body, response.status) };
  return { ok: true, value: body };
}

/** Call, then narrow the answer with `guard`. An answer the guard refuses is unreadable, never handed on. */
async function read<T>(
  path: string,
  init: LeaderboardRequestInit,
  options: LeaderboardClientOptions,
  guard: (value: unknown) => value is T,
): Promise<LeaderboardResult<T>> {
  const result = await callLeaderboard(path, init, options);
  if (!result.ok) return result;
  if (!guard(result.value)) return { ok: false, failure: LEADERBOARD_UNREADABLE };
  return { ok: true, value: result.value };
}

/** A JSON request with `method` and `body`. */
function json(method: string, body: unknown): LeaderboardRequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function isBoardTier(value: unknown): value is BoardTier {
  return isRecord(value) && isText(value.key) && isNumber(value.from);
}

function isBoardSummary(value: unknown): value is BoardSummary {
  if (!isRecord(value)) return false;
  if (!isText(value.key) || !isText(value.store) || !isText(value.direction) || !isText(value.aggregation))
    return false;
  if (value.window !== null && !isText(value.window)) return false;
  return Array.isArray(value.tiers) && value.tiers.every(isBoardTier);
}

function isBoardList(value: unknown): value is { boards: BoardSummary[] } {
  return isRecord(value) && Array.isArray(value.boards) && value.boards.every(isBoardSummary);
}

function isRankedEntry(value: unknown): value is RankedEntry {
  if (!isRecord(value)) return false;
  if (!isText(value.userId) || !isNumber(value.score) || !isText(value.achievedAt) || !isNumber(value.rank))
    return false;
  return value.tier === null || isText(value.tier);
}

function isBoardPage(value: unknown): value is BoardPage {
  return (
    isRecord(value) &&
    isText(value.board) &&
    isText(value.window) &&
    Array.isArray(value.entries) &&
    value.entries.every(isRankedEntry)
  );
}

function isOwnRank(value: unknown): value is OwnRank {
  if (!isRecord(value)) return false;
  if (!isText(value.board) || !isText(value.window) || !isText(value.userId) || !isNumber(value.score)) return false;
  if (value.rank !== null && !isNumber(value.rank)) return false;
  if (value.tier !== null && !isText(value.tier)) return false;
  return typeof value.visible === "boolean" && typeof value.rankStale === "boolean";
}

function isSubmitResult(value: unknown): value is { window: string } {
  return isRecord(value) && isText(value.window);
}

function isVisibilityResult(value: unknown): value is { visible: boolean } {
  return isRecord(value) && typeof value.visible === "boolean";
}

function isHideResult(value: unknown): value is { hidden: boolean } {
  return isRecord(value) && typeof value.hidden === "boolean";
}

function isRemoveResult(value: unknown): value is { removed: boolean } {
  return isRecord(value) && typeof value.removed === "boolean";
}

/** Every board this Worker serves. */
export async function listBoards(options: LeaderboardClientOptions = {}): Promise<LeaderboardResult<BoardSummary[]>> {
  const result = await read("", { method: "GET" }, options, isBoardList);
  return result.ok ? { ok: true, value: result.value.boards } : result;
}

/**
 * Submit a score to `board`, for the caller's token. Answers the window it landed in. Needs the submit
 * scope while the Worker is `serverAuthoritative`, which is the default.
 */
export async function submitScore(
  board: string,
  score: number,
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<string>> {
  const result = await read(`/${segment(board)}`, json("POST", { score }), options, isSubmitResult);
  return result.ok ? { ok: true, value: result.value.window } : result;
}

/** A page of the top of `board`, best first. */
export function readTop(
  board: string,
  page: TopOptions = {},
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<BoardPage>> {
  const search = query({ window: page.window, limit: page.limit, offset: page.offset });
  return read(`/${segment(board)}/top${search}`, { method: "GET" }, options, isBoardPage);
}

/** `board` ranked among a segment of players, such as a friends list. */
export function readSegment(
  board: string,
  page: SegmentOptions,
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<BoardPage>> {
  const body = { userIds: page.userIds, limit: page.limit, offset: page.offset, window: page.window };
  return read(`/${segment(board)}/segment`, json("POST", body), options, isBoardPage);
}

/** The caller's own standing on `board`. */
export function readOwnRank(
  board: string,
  at: WindowOptions = {},
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<OwnRank>> {
  return read(`/${segment(board)}/me${query({ window: at.window })}`, { method: "GET" }, options, isOwnRank);
}

/** The players ranked around the caller on `board`. */
export function readAround(
  board: string,
  around: AroundOptions = {},
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<BoardPage>> {
  const search = query({ window: around.window, radius: around.radius });
  return read(`/${segment(board)}/around${search}`, { method: "GET" }, options, isBoardPage);
}

/** Show or hide the caller's own entry on `board`. Answers the visibility as now stored. */
export async function setVisibility(
  board: string,
  visible: boolean,
  at: WindowOptions = {},
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<boolean>> {
  const path = `/${segment(board)}/me/visibility${query({ window: at.window })}`;
  const result = await read(path, json("PUT", { visible }), options, isVisibilityResult);
  return result.ok ? { ok: true, value: result.value.visible } : result;
}

/** Hide or restore another player's entry. Needs the admin scope. Answers whether it is now hidden. */
export async function hideEntry(
  board: string,
  userId: string,
  hidden: boolean,
  at: WindowOptions = {},
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<boolean>> {
  const path = `/${segment(board)}/entries/${segment(userId)}/hidden${query({ window: at.window })}`;
  const result = await read(path, json("PUT", { hidden }), options, isHideResult);
  return result.ok ? { ok: true, value: result.value.hidden } : result;
}

/** Remove another player's entry. Needs the admin scope. An entry that is not there is `leaderboard/entry_not_found`. */
export async function removeEntry(
  board: string,
  userId: string,
  at: WindowOptions = {},
  options: LeaderboardClientOptions = {},
): Promise<LeaderboardResult<boolean>> {
  const path = `/${segment(board)}/entries/${segment(userId)}${query({ window: at.window })}`;
  const result = await read(path, { method: "DELETE" }, options, isRemoveResult);
  return result.ok ? { ok: true, value: result.value.removed } : result;
}
