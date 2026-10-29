// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The client half of `@pithy-sh/organization`: how a browser or native program asks this Worker what the
 * reader may act in, tells it which one they chose, and reads and accepts an invitation.
 *
 * **It exists for the reason `@pithy-sh/auth`'s counterpart does.** `pithy ui add` writes a screen once
 * and may never rewrite it — the file is copied into the adopter's repository and becomes theirs — so a
 * request spelled out inside one is frozen at the moment it was copied, and a later fix to the base
 * path or the failure wording reaches none of them. The calls live here and upgrade with a release.
 *
 * **Nothing here imports anything, and that is structural rather than tidy.** This module compiles into
 * a browser bundle; importing `../data/*` would drag the Worker's Zod graph in behind it. So the wire
 * shapes are declared literally and narrowed by hand-written guards, and the same-origin rule is a
 * check in {@link callOrganization} rather than a convention a caller could forget.
 *
 * **Nothing throws.** With no imports, `PithyError` is not in reach and a bare `throw new Error` is what
 * this kit forbids. An unreachable Worker, a proxy's HTML error page, a 500 — each becomes a renderable
 * {@link OrganizationFailure}, and every caller answers one. The Worker is still the security boundary;
 * nothing on this side of the wire protects anything, it only decides what a screen shows.
 *
 * **And one thing this module deliberately cannot do: tell a refusal apart from a missing account.** The
 * server answers `organization/not_found` both for an organization that does not exist and for one the
 * reader does not belong to, byte for byte, because a distinguishable refusal is an existence oracle. A
 * client that tried to be more helpful about which it was would be inventing the distinction the server
 * spent the design refusing to draw.
 */

/** Where the tenancy routes mount by default — the same default `OrganizationConfig.basePath` carries. */
export const ORGANIZATION_BASE_PATH = "/organizations";

/**
 * The slice of `fetch` this module uses, declared structurally.
 *
 * Not `typeof fetch`: the package compiles against `@cloudflare/workers-types`, whose `RequestInit` has
 * no `credentials` — and `credentials: "include"` is the entire cookie story.
 */
export interface OrganizationRequestInit {
  /** The HTTP method. Absent means GET. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** The JSON body, already serialized. */
  body?: string;
  /**
   * Cookie policy. `include` on the same origin, where the session is an httpOnly cookie; `omit` once an
   * {@link OrganizationClientOptions.origin} is set, where the credential is a bearer the fetch adds.
   */
  credentials?: "include" | "same-origin" | "omit";
}

/** The slice of `Response` this module reads. */
export interface OrganizationResponse {
  /** Whether the status was 2xx. */
  ok: boolean;
  /** The HTTP status. */
  status: number;
  /** The parsed body, or a rejection when it was not JSON. */
  json(): Promise<unknown>;
}

/** A fetch this module can call. */
export type OrganizationFetch = (input: string, init?: OrganizationRequestInit) => Promise<OrganizationResponse>;

/** The browser globals this module reaches for, as an injectable seam. */
export interface OrganizationGlobal {
  /** The browser's fetch. */
  fetch?: OrganizationFetch;
}

/** What every call takes: where the routes are, and the seams a test replaces. */
export interface OrganizationClientOptions {
  /**
   * The Worker's absolute origin, for a program it does not serve: a native app. `scheme://host[:port]`
   * over http or https and nothing else, no path, no trailing slash. Absent, every request is a rooted
   * path on the page's own origin carrying its cookie. Present, the request goes to this origin with no
   * cookie, and the credential is whatever the `fetch` handed in adds.
   */
  origin?: string;
  /** Where the tenancy routes mount. Defaults to {@link ORGANIZATION_BASE_PATH}. */
  basePath?: string;
  /** The fetch to use. Defaults to the one on {@link OrganizationClientOptions.global}. */
  fetch?: OrganizationFetch;
  /** The global object the default fetch comes off. Defaults to `globalThis`. */
  global?: OrganizationGlobal;
}

/** A refusal a screen can render: the namespaced code, the public message, and what to do next. */
export interface OrganizationFailure {
  /** The namespaced code — `organization/not_found`, or a `client/*` sentinel this module minted. */
  code: string;
  /** The public message. The server's `detail` never crosses the HTTP codec, so this is all there is. */
  message: string;
  /** What to do next, when the server offered one. */
  action: string | null;
}

/** Either the value, or a failure to render. Never a throw. */
export type OrganizationResult<T> = { ok: true; value: T } | { ok: false; failure: OrganizationFailure };

/** The worker could not be reached at all. Offline, or a DNS failure, or no fetch in this program. */
export const ORGANIZATION_UNREACHABLE: OrganizationFailure = {
  code: "client/unreachable",
  message: "We couldn't reach the server.",
  action: "Check your connection, then try again.",
};

/** The worker answered with something this client cannot read. A proxy's HTML page, or a shape change. */
export const ORGANIZATION_UNREADABLE: OrganizationFailure = {
  code: "client/unreadable",
  message: "The server answered with something we couldn't read.",
  action: "Try again. If it keeps happening, the app and the backend are out of step.",
};

/**
 * The request would have left this origin, so it was never sent.
 *
 * Reachable through a `basePath` that is not a rooted path, or an `origin` that is not a bare http(s)
 * origin. Sending it would attach a session to a request this program is not entitled to make — and here
 * that session is the whole of somebody's membership in every account they belong to.
 */
export const ORGANIZATION_CROSS_ORIGIN: OrganizationFailure = {
  code: "client/cross_origin",
  message: "That request would have left this site, so it wasn't sent.",
  action:
    "Check the organization `basePath` in pithy.config.ts, which is a path on the worker and not a URL, and the client's `origin`, which is a scheme and host with no path.",
};

/** One organization the reader may act in, as the chooser draws it. */
export interface ActableOrganization {
  /** The organization's id — what {@link chooseOrganization} takes. */
  id: string;
  /** Its display name. */
  name: string;
  /** Its URL-safe short name. */
  slug: string;
  /** What the reader may do here, as a name from this project's own catalog. */
  role: string;
  /**
   * Where to draw its mark from, or null for initials.
   *
   * A URL on this origin for a raster, and the stored value itself for a vector — the server decides
   * which, and a screen renders whichever it is handed through the same `<img src>`. Named `mark` to
   * match the wire rather than `logo`, which is what the *column* is called.
   */
  mark: string | null;
  /** When the organization was created, ISO-8601. */
  createdAt: string;
}

/** What the reader may act in, and which one is in force. */
export interface ActableOrganizations {
  /** Every organization the reader belongs to, ordered by name. */
  organizations: ActableOrganization[];
  /**
   * The organization in force, or null when nothing has been chosen.
   *
   * Null with a non-empty list is the ordinary state of a fresh session, and it is what the chooser
   * exists for. Null with an empty list is somebody who belongs nowhere, which is a different screen.
   */
  acting: string | null;
  /**
   * Whether the organization in force was **picked**, as against being the only one there is.
   *
   * The distinction a single `activeOrganizationId` column cannot carry, and the one a chooser keys on:
   * somebody put into their only account did not choose it, and offering them a switcher is noise.
   */
  chosen: boolean;
  /**
   * How many of the reader's organizations are suspended, and so not in `organizations`. Non-zero with an
   * empty list is somebody whose organizations are all suspended — the suspended screen, not the invitation one.
   * Optional because a server that predates suspension does not send it.
   */
  suspended?: number;
}

/** Whether a value is a plain record — the first step of every guard below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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

/**
 * Whether a configured origin is a bare http(s) origin: a scheme, a host, an optional port, nothing else.
 *
 * A regular expression rather than `new URL`, because React Native's `URL` does not implement the
 * getters a parsed check would read. Userinfo, a path, a query, a fragment, a backslash and whitespace
 * are all refused, so the composed URL can only ever name this host.
 */
function isBareOrigin(origin: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$|^https?:\/\/\[[0-9A-Fa-f:.]+\](?::[0-9]{1,5})?$/.test(origin);
}

/**
 * A failure read off the envelope this Worker answers with, or the generic one when the body is not it.
 *
 * One shape here, unlike `@pithy-sh/auth`'s counterpart: every route this capability ships is its own,
 * so every refusal arrives through `pithyErrorHandler` as `{ error: { code, message, action } }`. There
 * is no second library answering in its own dialect.
 */
function failureFrom(body: unknown, status: number): OrganizationFailure {
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    if (isText(error.code) && isText(error.message)) {
      return {
        code: error.code,
        message: error.message,
        action: isText(error.action) ? error.action : null,
      };
    }
  }
  return {
    code: `client/http_${status}`,
    message: ORGANIZATION_UNREADABLE.message,
    action: ORGANIZATION_UNREADABLE.action,
  };
}

/**
 * One request to this Worker's tenancy routes.
 *
 * The one place the transport is written down. With no `origin`, `credentials: "include"` and nothing
 * else — no token in storage, no `Authorization` header: the SPA and its Worker share an origin, so the
 * session rides an httpOnly cookie JavaScript cannot read, and the server's `requireSameOrigin()` is the
 * other half of the CSRF rule. With an `origin`, `credentials: "omit"`: the program is not served by the
 * Worker, its credential is the bearer the handed-in `fetch` adds, and a request without a cookie is one
 * the server's CSRF gate exempts.
 */
async function callOrganization(
  path: string,
  init: OrganizationRequestInit,
  options: OrganizationClientOptions,
): Promise<OrganizationResult<unknown>> {
  const base = options.basePath ?? ORGANIZATION_BASE_PATH;
  const rooted = `${base}${path}`;
  // Checked before the request is built, not after it fails. A `basePath` naming another host, or an
  // `origin` carrying more than a host, would otherwise send this reader's session somewhere they never
  // agreed to.
  if (!isSameOriginPath(rooted)) return { ok: false, failure: ORGANIZATION_CROSS_ORIGIN };
  const { origin } = options;
  if (origin !== undefined && !isBareOrigin(origin)) return { ok: false, failure: ORGANIZATION_CROSS_ORIGIN };
  const url = origin === undefined ? rooted : `${origin}${rooted}`;

  const send = options.fetch ?? (options.global ?? (globalThis as OrganizationGlobal)).fetch;
  if (!send) return { ok: false, failure: ORGANIZATION_UNREACHABLE };

  let response: OrganizationResponse;
  try {
    response = await send(url, { ...init, credentials: origin === undefined ? "include" : "omit" });
  } catch {
    // Offline, DNS, a refused connection. Nothing to read and nothing to say beyond "try again".
    return { ok: false, failure: ORGANIZATION_UNREACHABLE };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A proxy's HTML error page, or an empty body on a status that promised one.
    return { ok: false, failure: response.ok ? ORGANIZATION_UNREADABLE : failureFrom(undefined, response.status) };
  }

  if (!response.ok) return { ok: false, failure: failureFrom(body, response.status) };
  return { ok: true, value: body };
}

/** Narrow one row of the chooser's list. A row missing a field is a row the chooser cannot draw. */
function isActableOrganization(value: unknown): value is ActableOrganization {
  if (!isRecord(value)) return false;
  if (!isText(value.id) || !isText(value.name) || !isText(value.slug) || !isText(value.role)) return false;
  if (!isText(value.createdAt)) return false;
  return value.mark === null || typeof value.mark === "string";
}

/** Narrow the chooser's whole answer. */
function isActableOrganizations(value: unknown): value is ActableOrganizations {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.organizations) || !value.organizations.every(isActableOrganization)) return false;
  if (value.acting !== null && !isText(value.acting)) return false;
  if (value.suspended !== undefined && (typeof value.suspended !== "number" || value.suspended < 0)) return false;
  return typeof value.chosen === "boolean";
}

/** What is in force after a choice, read back from the row the choice wrote. */
export interface ChosenOrganization {
  /** The organization now in force for this session. */
  organizationId: string;
  /** Its display name, so a header re-reads from the answer rather than from what was sent. */
  name: string;
  /** Its short name. */
  slug: string;
  /** The reader's role in it, read off the membership rather than from the request. */
  role: string;
  /** True — somebody picked this. The field exists so a chooser can stop asking. */
  chosen: boolean;
}

/** Narrow the answer a choice reads back. */
function isChosenOrganization(value: unknown): value is ChosenOrganization {
  if (!isRecord(value)) return false;
  if (!isText(value.organizationId) || !isText(value.name) || !isText(value.slug) || !isText(value.role)) return false;
  return typeof value.chosen === "boolean";
}

/**
 * What this reader may act in, and what is in force.
 *
 * The chooser's whole read. Three arrivals come out of one call, and a screen has to tell them apart:
 * nobody (an invitation is the answer), exactly one (go straight through, and still record the choice),
 * or several (draw the picker).
 */
export async function listOrganizations(
  options: OrganizationClientOptions = {},
): Promise<OrganizationResult<ActableOrganizations>> {
  const result = await callOrganization("", { method: "GET" }, options);
  if (!result.ok) return result;
  if (!isActableOrganizations(result.value)) return { ok: false, failure: ORGANIZATION_UNREADABLE };
  return { ok: true, value: result.value };
}

/**
 * Act in this organization from now on.
 *
 * **The membership is proved server-side in the same statement that records the choice**, so a caller
 * naming an organization they do not belong to gets the ordinary 404 and nothing is written. There is
 * nothing for this side of the wire to check first, and a check here would only be a second answer to
 * a question the server is the authority on.
 *
 * A screen leaves by a **document load** rather than an in-app navigation after this succeeds. What is
 * in force changes what every subsequent request may reach, and a client-side route change would keep
 * whatever the previous account's data had already populated.
 */
export async function chooseOrganization(
  organizationId: string,
  options: OrganizationClientOptions = {},
): Promise<OrganizationResult<ChosenOrganization>> {
  const result = await callOrganization(
    "/acting",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId }) },
    options,
  );
  if (!result.ok) return result;
  // Read back from the answer rather than echoed from the request. The role in particular is read off
  // the membership the write proved, so a header drawn from this cannot show a standing nobody has.
  if (!isChosenOrganization(result.value)) return { ok: false, failure: ORGANIZATION_UNREADABLE };
  return { ok: true, value: result.value };
}

/** What an accept screen shows somebody holding an invitation link, and nothing more. */
export interface InvitationOffer {
  /** The organization being joined, by display name. Tenant text: render it as text, never as markup. */
  organizationName: string;
  /** What the sender calls themselves, or null when their account is gone. Tenant text too. */
  inviterName: string | null;
  /** What accepting confers, as a name from this project's own catalog. */
  role: string;
  /** When the link stops working, ISO-8601. */
  expiresAt: string;
}

/** Narrow an offer. */
function isInvitationOffer(value: unknown): value is InvitationOffer {
  if (!isRecord(value)) return false;
  if (!isText(value.organizationName) || !isText(value.role) || !isText(value.expiresAt)) return false;
  return value.inviterName === null || typeof value.inviterName === "string";
}

/** The membership an accepted invitation produced. */
export interface AcceptedInvitation {
  /** The organization joined. */
  organizationId: string;
  /** The membership, new or the one already held. */
  membershipId: string;
  /** What was granted: the role the offer carried, never one the request named. */
  role: string;
  /**
   * False when the reader was already a member. The offer is consumed either way, so accepting twice is
   * a success a screen can word differently, not a refusal it has to tell apart.
   */
  joined: boolean;
}

/** Narrow an acceptance. */
function isAcceptedInvitation(value: unknown): value is AcceptedInvitation {
  if (!isRecord(value)) return false;
  if (!isText(value.organizationId) || !isText(value.membershipId) || !isText(value.role)) return false;
  return typeof value.joined === "boolean";
}

/**
 * What an invitation link offers, read before anybody is asked to accept it.
 *
 * Public: a reader who is not signed in yet can see what they were invited to. Every refusal — unknown,
 * spent, withdrawn, expired — is the server's one `organization/invitation_invalid` sentence, so neither
 * side of the wire can tell which offers exist. The token travels as one encoded path segment.
 */
export async function readInvitation(
  token: string,
  options: OrganizationClientOptions = {},
): Promise<OrganizationResult<InvitationOffer>> {
  const result = await callOrganization(`/invitations/${encodeURIComponent(token)}`, { method: "GET" }, options);
  if (!result.ok) return result;
  if (!isInvitationOffer(result.value)) return { ok: false, failure: ORGANIZATION_UNREADABLE };
  return { ok: true, value: result.value };
}

/**
 * Accept an invitation as the signed-in reader.
 *
 * The token goes in the JSON body, which is where the route reads it. Joining **does not move** the
 * organization in force: a screen that wants the reader acting in the one they just joined calls
 * {@link chooseOrganization} with the `organizationId` this answers.
 */
export async function acceptInvitation(
  token: string,
  options: OrganizationClientOptions = {},
): Promise<OrganizationResult<AcceptedInvitation>> {
  const result = await callOrganization(
    "/invitations/accept",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) },
    options,
  );
  if (!result.ok) return result;
  if (!isAcceptedInvitation(result.value)) return { ok: false, failure: ORGANIZATION_UNREADABLE };
  return { ok: true, value: result.value };
}
