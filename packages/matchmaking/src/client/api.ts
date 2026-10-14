// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The client half of `@pithy-sh/matchmaking`: how a web app the Worker serves opens a room, sends and
 * answers an invite, keeps a friend list and waits in the open queue.
 *
 * **It is for a web app on the Worker's own origin, and nothing else.** Every call takes a rooted
 * same-origin path — `basePath` must start with `/` — so there is no host to point it at. A React Native
 * app or a game engine is not on that origin and cannot use it: generate its client from the Worker's
 * `openapi.json` for the routes and `asyncapi.json` for the presence socket instead.
 *
 * **It exists for the reason `@pithy-sh/organization`'s counterpart does.** A request spelled out inside
 * an app is frozen at the moment it was written, and a later fix to a path or a failure's wording reaches
 * none of them. The calls live here and upgrade with a release.
 *
 * **Nothing here imports anything, and that is structural rather than tidy.** This module compiles into a
 * client bundle; importing `../http/responses` would drag the Worker's Zod graph in behind it. So the wire
 * shapes are declared literally and narrowed by hand-written guards, and the same-origin rule is a check
 * in {@link callMatchmaking} rather than a convention a caller could forget. The presence socket's frames
 * are the exception a client may import: `../presence/frames` is pure and describes them with Zod.
 *
 * **Nothing throws.** An unreachable Worker, a proxy's HTML error page, a 500 — each becomes a renderable
 * {@link MatchmakingFailure}, and every caller answers one. The Worker is still the security boundary;
 * nothing on this side of the wire protects anything, it only decides what a screen shows.
 *
 * **The session cookie is the usual credential.** A web app on the Worker's origin rides its session
 * cookie, which `credentials: "include"` sends. One that holds a bearer token instead passes
 * `headers: { authorization: "Bearer …" }` on each call.
 */

/** Where the matchmaking routes mount by default — the same default `matchmaking({ basePath })` carries. */
export const MATCHMAKING_BASE_PATH = "/matchmaking";

/** The subprotocol to offer when opening the presence socket. */
export const MATCHMAKING_PRESENCE_PROTOCOL = "pithy.presence.v1";

/**
 * The slice of `fetch` this module uses, declared structurally.
 *
 * Not `typeof fetch`: the package compiles against `@cloudflare/workers-types`, whose `RequestInit` has
 * no `credentials` — and `credentials: "include"` is the entire cookie story.
 */
export interface MatchmakingRequestInit {
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
export interface MatchmakingResponse {
  /** Whether the status was 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The parsed body, or a rejection when it was not JSON. */
  json(): Promise<unknown>;
}

/** A fetch this module can call. */
export type MatchmakingFetch = (input: string, init?: MatchmakingRequestInit) => Promise<MatchmakingResponse>;

/** The globals this module reaches for, as an injectable seam. */
export interface MatchmakingGlobal {
  /** The program's fetch. */
  fetch?: MatchmakingFetch;
}

/** What every call takes: where the routes are, how the caller is identified, and the seams a test replaces. */
export interface MatchmakingClientOptions {
  /** Where the matchmaking routes mount. Defaults to {@link MATCHMAKING_BASE_PATH}. */
  basePath?: string;
  /** Extra request headers — a bearer client's `authorization`. A cookie session needs none. */
  headers?: Record<string, string>;
  /** The fetch to use. Defaults to the one on {@link MatchmakingClientOptions.global}. */
  fetch?: MatchmakingFetch;
  /** The global object the default fetch comes off. Defaults to `globalThis`. */
  global?: MatchmakingGlobal;
}

/** A refusal a screen can render: the namespaced code, the public message, and what to do next. */
export interface MatchmakingFailure {
  /** The namespaced code — `matchmaking/room_not_found`, or a `client/*` sentinel this module minted. */
  code: string;
  /** The public message. The server's `detail` never crosses the HTTP codec, so this is all there is. */
  message: string;
  /** What to do next, when the server offered one. */
  action: string | null;
}

/** Either the value, or a failure to render. Never a throw. */
export type MatchmakingResult<T> = { ok: true; value: T } | { ok: false; failure: MatchmakingFailure };

/** The worker could not be reached at all. Offline, or a DNS failure, or no fetch in this program. */
export const MATCHMAKING_UNREACHABLE: MatchmakingFailure = {
  code: "client/unreachable",
  message: "We couldn't reach the server.",
  action: "Check your connection, then try again.",
};

/** The worker answered with something this client cannot read. A proxy's HTML page, or a shape change. */
export const MATCHMAKING_UNREADABLE: MatchmakingFailure = {
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
export const MATCHMAKING_CROSS_ORIGIN: MatchmakingFailure = {
  code: "client/cross_origin",
  message: "That request would have left this site, so it wasn't sent.",
  action: "Check the matchmaking `basePath` in pithy.config.ts — it is a path on this worker, not a URL.",
};

/** A freshly opened room: its join code and the session behind it. */
export interface RoomCreated {
  /** The shareable join code, in the canonical `WXYZ-1234` form. */
  code: string;
  /** The multiplayer session the room seats players into. The host is already in it. */
  sessionId: string;
}

/** The session a room code seated the caller into. */
export interface RoomJoined {
  /** The multiplayer session the caller was seated into. */
  sessionId: string;
  /** How many more times the code can be redeemed after this join. */
  usesRemaining: number;
}

/** A direct invite's state. */
export type InviteStatus = "pending" | "accepted" | "declined";

/** One direct invite from one player to another. */
export interface InviteView {
  /** The invite's UUID, the id {@link acceptInvite} and {@link declineInvite} take. */
  id: string;
  /** The matchmaking game the invite is for. */
  gameKey: string;
  /** The user who sent the invite. */
  inviterId: string;
  /** The user the invite was sent to. */
  inviteeId: string;
  /** The invite's current state. */
  status: InviteStatus;
  /** The multiplayer session minted when the invite was accepted, or null while pending or declined. */
  sessionId: string | null;
  /** When the invite was sent, ISO-8601. */
  createdAt: string;
  /** When the invitee accepted or declined, ISO-8601, or null while pending. */
  respondedAt: string | null;
}

/** Whom to invite: an email or a screen name, never both. */
export type InviteTarget = { email: string; name?: never } | { name: string; email?: never };

/** One friend edge, seen from the caller's side. */
export interface FriendView {
  /** The other user in the edge. */
  userId: string;
  /** Whether the edge is a pending request or an accepted friendship. */
  status: "pending" | "accepted";
  /** For a pending request, who sent it. `mutual` once accepted. */
  direction: "incoming" | "outgoing" | "mutual";
  /** When the edge last changed, ISO-8601. */
  since: string;
}

/** The caller's standing in a game's open queue. */
export interface QueueStanding {
  /** `queued` while the caller waits, `matched` once a full roster formed around them. */
  state: "queued" | "matched";
  /** The multiplayer session the match was seated into, or null while still queued. */
  sessionId: string | null;
  /** How long the caller has waited, in milliseconds. */
  waitingMs: number;
}

/** Whether a value is a plain record — the first step of every guard below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether a value is a string or null. */
function isTextOrNull(value: unknown): value is string | null {
  return value === null || isText(value);
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
function failureFrom(body: unknown, status: number): MatchmakingFailure {
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    if (isText(error.code) && isText(error.message)) {
      return { code: error.code, message: error.message, action: isText(error.action) ? error.action : null };
    }
  }
  return {
    code: `client/http_${status}`,
    message: MATCHMAKING_UNREADABLE.message,
    action: MATCHMAKING_UNREADABLE.action,
  };
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

/**
 * One same-origin request to this Worker's matchmaking routes.
 *
 * The one place the transport is written down: `credentials: "include"` for a cookie session, plus any
 * headers the caller passed for a bearer token. A 204 answers `null`: those routes return no body.
 */
async function callMatchmaking(
  path: string,
  init: MatchmakingRequestInit,
  options: MatchmakingClientOptions,
): Promise<MatchmakingResult<unknown>> {
  const url = `${options.basePath ?? MATCHMAKING_BASE_PATH}${path}`;
  // Checked before the request is built, not after it fails. A `basePath` naming another host would
  // otherwise send this reader's session somewhere they never agreed to.
  if (!isSameOriginPath(url)) return { ok: false, failure: MATCHMAKING_CROSS_ORIGIN };

  const send = options.fetch ?? (options.global ?? (globalThis as MatchmakingGlobal)).fetch;
  if (!send) return { ok: false, failure: MATCHMAKING_UNREACHABLE };

  let response: MatchmakingResponse;
  try {
    response = await send(url, {
      ...init,
      headers: { ...options.headers, ...init.headers },
      credentials: "include",
    });
  } catch {
    return { ok: false, failure: MATCHMAKING_UNREACHABLE };
  }

  if (response.ok && response.status === 204) return { ok: true, value: null };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: response.ok ? MATCHMAKING_UNREADABLE : failureFrom(undefined, response.status) };
  }

  if (!response.ok) return { ok: false, failure: failureFrom(body, response.status) };
  return { ok: true, value: body };
}

/** Call, then narrow the answer with `guard`. An answer the guard refuses is unreadable, never handed on. */
async function read<T>(
  path: string,
  init: MatchmakingRequestInit,
  options: MatchmakingClientOptions,
  guard: (value: unknown) => value is T,
): Promise<MatchmakingResult<T>> {
  const result = await callMatchmaking(path, init, options);
  if (!result.ok) return result;
  if (!guard(result.value)) return { ok: false, failure: MATCHMAKING_UNREADABLE };
  return { ok: true, value: result.value };
}

/** Whether a value is the empty answer a 204 route gives. */
function isEmpty(value: unknown): value is null {
  return value === null;
}

function isRoomCreated(value: unknown): value is RoomCreated {
  return isRecord(value) && isText(value.code) && isText(value.sessionId);
}

function isRoomJoined(value: unknown): value is RoomJoined {
  return isRecord(value) && isText(value.sessionId) && typeof value.usesRemaining === "number";
}

function isInviteView(value: unknown): value is InviteView {
  if (!isRecord(value)) return false;
  if (!isText(value.id) || !isText(value.gameKey) || !isText(value.inviterId) || !isText(value.inviteeId)) return false;
  if (value.status !== "pending" && value.status !== "accepted" && value.status !== "declined") return false;
  return isTextOrNull(value.sessionId) && isText(value.createdAt) && isTextOrNull(value.respondedAt);
}

function isInviteList(value: unknown): value is { invites: InviteView[] } {
  return isRecord(value) && Array.isArray(value.invites) && value.invites.every(isInviteView);
}

function isFriendView(value: unknown): value is FriendView {
  if (!isRecord(value) || !isText(value.userId) || !isText(value.since)) return false;
  if (value.status !== "pending" && value.status !== "accepted") return false;
  return value.direction === "incoming" || value.direction === "outgoing" || value.direction === "mutual";
}

function isFriendList(value: unknown): value is { friends: FriendView[] } {
  return isRecord(value) && Array.isArray(value.friends) && value.friends.every(isFriendView);
}

function isQueueStanding(value: unknown): value is QueueStanding {
  if (!isRecord(value)) return false;
  if (value.state !== "queued" && value.state !== "matched") return false;
  return isTextOrNull(value.sessionId) && typeof value.waitingMs === "number";
}

const POST: MatchmakingRequestInit = { method: "POST" };
const DELETE: MatchmakingRequestInit = { method: "DELETE" };

/**
 * The presence socket's path, for `new WebSocket(path, MATCHMAKING_PRESENCE_PROTOCOL)`.
 *
 * Refused like a request when the `basePath` would leave this origin. Its frames are typed by
 * `@pithy-sh/matchmaking/src/presence/frames`.
 */
export function presencePath(options: Pick<MatchmakingClientOptions, "basePath"> = {}): MatchmakingResult<string> {
  const path = `${options.basePath ?? MATCHMAKING_BASE_PATH}/presence`;
  if (!isSameOriginPath(path)) return { ok: false, failure: MATCHMAKING_CROSS_ORIGIN };
  return { ok: true, value: path };
}

/** Open a room for `game`, with a shareable join code. The caller is the host, already seated. */
export function createRoom(
  game: string,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<RoomCreated>> {
  return read(`/games/${segment(game)}/rooms`, POST, options, isRoomCreated);
}

/** Join a room by its code. A dashless or lowercase code is accepted as typed. */
export function joinRoom(code: string, options: MatchmakingClientOptions = {}): Promise<MatchmakingResult<RoomJoined>> {
  return read(`/rooms/${segment(code)}/join`, POST, options, isRoomJoined);
}

/** Invite another player to a two-player `game`, by email or by screen name. */
export function sendInvite(
  game: string,
  target: InviteTarget,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<InviteView>> {
  return read(
    `/games/${segment(game)}/invites`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target) },
    options,
    isInviteView,
  );
}

/** The invites waiting on the caller, newest first. */
export async function listInvites(options: MatchmakingClientOptions = {}): Promise<MatchmakingResult<InviteView[]>> {
  const result = await read("/invites", { method: "GET" }, options, isInviteList);
  return result.ok ? { ok: true, value: result.value.invites } : result;
}

/** Accept an invite. Its session is minted, and the answer carries it. */
export function acceptInvite(
  id: string,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<InviteView>> {
  return read(`/invites/${segment(id)}/accept`, POST, options, isInviteView);
}

/** Decline an invite. */
export function declineInvite(
  id: string,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<InviteView>> {
  return read(`/invites/${segment(id)}/decline`, POST, options, isInviteView);
}

/** The caller's friends and pending requests. A Worker with `friends: false` answers 404. */
export async function listFriends(options: MatchmakingClientOptions = {}): Promise<MatchmakingResult<FriendView[]>> {
  const result = await read("/friends", { method: "GET" }, options, isFriendList);
  return result.ok ? { ok: true, value: result.value.friends } : result;
}

/** Send a friend request to `userId`. */
export function requestFriend(
  userId: string,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<null>> {
  return read(`/friends/${segment(userId)}/request`, POST, options, isEmpty);
}

/** Accept `userId`'s friend request. */
export function acceptFriend(userId: string, options: MatchmakingClientOptions = {}): Promise<MatchmakingResult<null>> {
  return read(`/friends/${segment(userId)}/accept`, POST, options, isEmpty);
}

/** Decline `userId`'s friend request. */
export function declineFriend(
  userId: string,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<null>> {
  return read(`/friends/${segment(userId)}/decline`, POST, options, isEmpty);
}

/** Remove `userId` as a friend. */
export function removeFriend(userId: string, options: MatchmakingClientOptions = {}): Promise<MatchmakingResult<null>> {
  return read(`/friends/${segment(userId)}`, DELETE, options, isEmpty);
}

/** Join `game`'s open queue. A full roster may form at once, and the answer says so. */
export function joinQueue(
  game: string,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<QueueStanding>> {
  return read(`/games/${segment(game)}/queue`, POST, options, isQueueStanding);
}

/** The caller's standing in `game`'s queue. A match is delivered once: the read that reports it clears it. */
export function readQueue(
  game: string,
  options: MatchmakingClientOptions = {},
): Promise<MatchmakingResult<QueueStanding>> {
  return read(`/games/${segment(game)}/queue`, { method: "GET" }, options, isQueueStanding);
}

/** Leave `game`'s open queue. */
export function leaveQueue(game: string, options: MatchmakingClientOptions = {}): Promise<MatchmakingResult<null>> {
  return read(`/games/${segment(game)}/queue`, DELETE, options, isEmpty);
}
