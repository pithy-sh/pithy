// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * Guard `errorCallbackURL` on the way **in**, so the refusal redirect is built from a URL the kit made (#625).
 *
 * ## Why an input guard, after two output-side rounds
 *
 * `./providerRefusal` reads the `Location` a refused social callback answers with and rewrites the
 * revealing code out of it. It has been walked around twice, and both times by changing one field of
 * `POST /sign-in/social`:
 *
 * | Round | `errorCallbackURL` | What the collapse did |
 * | --- | --- | --- |
 * | 1 | `/sign-in` | `new URL()` threw on a relative `Location`; returned early, code went out |
 * | 1 | `…?error=access_denied` | read the *first* `error`, which the caller had planted |
 * | 2 | `…/sign-in#x` | the appended `error=` landed inside the fragment; `searchParams` saw nothing |
 *
 * The third shape is the diagnosis rather than another entry. `better-auth`'s `redirectOnError`
 * (`dist/api/routes/callback.mjs:78`) is string concatenation that never parses:
 *
 * ```js
 * const url = `${baseURL}${baseURL.includes("?") ? "&" : "?"}${params.toString()}`;
 * ```
 *
 * and `baseURL` there is `errorURL`, which `oauth2/state.mjs:27` stored as the caller's raw string. So the
 * collapse parses the output of a concatenation performed without regard to URL structure, and **every
 * input shape where concatenation and parsing disagree is a new bypass.** `#x` was the third; a fourth
 * exists for as long as the caller chooses the string being concatenated. Patching the parser again finds
 * it later, from a report, rather than now.
 *
 * ## The invariant this module holds
 *
 * By the time `redirectOnError` concatenates, `errorURL` is **a URL the kit produced**:
 *
 * - no fragment — not a populated one, and not a bare trailing `#` either, which has an empty
 *   `URL.hash` and still swallows everything appended after it;
 * - no `error` and no `error_description` parameter already on it;
 * - a `?` in it **iff** it carries a query, so appending `?k=v` or `&k=v` — whichever the dependency
 *   picks — yields exactly one readable query either way.
 *
 * Then the concatenation is predictable by construction, and the collapse is reading a string this
 * capability wrote rather than one an attacker composed.
 *
 * ## Refused, never quietly rewritten
 *
 * Anything that cannot be normalized to that shape is refused at the door. Stripping a fragment or
 * deleting an `error` parameter would send the reader somewhere the adopter did not ask for and call it
 * a fix; a 400 naming the field is the honest answer, and it is read in development, where the value is
 * configured. What survives is canonicalization — what a browser would do to the same string anyway.
 *
 * ## Both guards, and why the other one stays
 *
 * `./providerRefusal` is **not** replaced. It becomes the second line: this module decides what the
 * dependency is handed, and that one still checks what the dependency answered. Keeping only one would
 * be a choice between two kinds of guessing, and the point of this round is to stop making either
 * carry the whole load — **an input guard that depends on out-guessing a dependency's string handling is
 * the thing this round exists to stop relying on.** So the guess is made once, here, about a value we
 * then own, and it is checked again at the other end against the roster.
 *
 * ## Scope: the field name, not a list of routes
 *
 * Every request through `handleBetterAuth` carrying an `errorCallbackURL` is guarded — `/sign-in/social`,
 * `/link-social`, `/sign-in/magic-link`. Deciding *per route* which of the dependency's code paths parse
 * the value and which concatenate it is exactly the out-guessing above, and it is a claim that goes stale
 * on the next bump. One field, one rule. (An adopter whose error screen is a hash route passes it as a
 * query parameter instead; the kit's own templates already do.)
 *
 * ## Reach: whatever the dependency reads the value from, this reads too
 *
 * Round 4 (#625) is not about what the guard decides but about which requests it looks inside, and it
 * was wrong twice in one function — **both times by testing something cheap instead of doing the parse
 * the test was standing in for.** A substring search of the raw body for `errorCallbackURL` misses
 * `"\u0065rrorCallbackURL"`, which is the same key after `JSON.parse` and shares no byte before it. A
 * `content-type` test for the literal `application/json` misses two of the three branches `getBody`
 * builds a keyed object in — form-encoded and multipart — and part of the third besides: the `+json`
 * structured-suffix family is JSON to the dependency's own regex and was not to that substring. Either
 * miss returned the request untouched and the fragment reached `redirectOnError` intact.
 *
 * So the dispatch below is `better-call/dist/utils.mjs`'s `getBody`, mirrored: the same
 * body-to-object branches, the same predicates, in the same order, guarded by the same `request.body`
 * test rather than by a list of verbs. Not a superset and not a subset — **equal**, because either
 * direction is a defect. Reading less leaves the bypass open; reading more refuses adopters over a
 * value Better Auth would never have been handed.
 *
 * That equality is not asserted in a comment. `errorCallbackUrlReach.workers.test.ts` runs both
 * programs over one corpus of request shapes and compares them case by case, with the dependency's
 * side executed rather than modeled, so a bump that teaches the dependency a new media type or a new
 * decoding turns it red naming the shape.
 *
 * **The prefilter that is gone, and the performance claim it rested on.** It read "the overwhelming
 * majority of bodies do not mention the field, and this spares them a parse." It spared them nothing
 * measurable: the body had *already* been cloned and read to a string one line above, which is the
 * copy, and what the prefilter avoided was a `JSON.parse` of a string in hand — on a body better-call
 * is about to parse anyway, microseconds later, in the same request. There was no work to save and no
 * exposure to add, so there was nothing on the other side of the trade to weigh the bypass against.
 *
 * ## Round 5: the same field, the other channel — and one decoder where there had been two
 *
 * Mirroring `getBody` fixed the reach of a guard that was still only reading **bodies**. Two holes
 * were left, and they are the two halves of the same sentence: *whatever the dependency reads the
 * value from*.
 *
 * **It also arrives in a query string.** `guardErrorCallbackURL` opened `if (!request.body) return
 * request`, and `better-auth/plugins`' own `oauthPopup()` takes the field off a `GET`:
 * `oauth-popup/index.mjs:143` stores `errorURL: c.query.errorCallbackURL`, and the router builds
 * `c.query` for every request whether or not it carries a body (`router.mjs:52`). The kit composes no
 * such plugin, but `AuthConfig.plugins` is a documented seam and `assertAdditivePlugins` permits that
 * id, so every adopter who adds one inherited round 3's oracle intact. The query is now normalized
 * where the body is, by the same rules, and a rebuilt value travels on a rebuilt URL.
 *
 * **And the two form branches were one decoder in the dependency and two here.** `getBody`'s
 * urlencoded branch calls `await request.formData()`; this module called
 * `new URLSearchParams(await request.clone().text())`. The predicates matched and the *decoders* did
 * not, and the gap between them is reachable, because the two programs answer "which encoding is
 * this?" with different halves of the same header. better-call's branch predicates `includes()` the
 * **whole** `content-type`, urlencoded first; `formData()` dispatches on its **essence**, the part
 * before the first `;`. So `multipart/form-data; note=application/x-www-form-urlencoded; boundary=…`
 * sends both programs into the urlencoded branch, where `formData()` reads the multipart body and
 * finds the field and `URLSearchParams` reads the same bytes as a query string and does not. The guard
 * returned the request untouched.
 *
 * That is fixed by **removing the choice, not by matching predicates harder** — the second would be
 * the same cheap-test mistake in a third place. `request.formData()` already handles both encodings
 * and dispatches on essence, which is why the dependency effectively has one decoder; so this module
 * has one too, and the mismatch cannot exist by construction. What survives of the distinction is the
 * one thing the dependency's two branches genuinely do differently *after* decoding — the urlencoded
 * branch stringifies every entry (`result[key] = value.toString()`) where the multipart branch keeps a
 * `File` — and that is mirrored, off the same predicate in the same order, because it decides whether
 * a file part is a value Better Auth acts on or a `BAD_REQUEST` it never reaches.
 */

/** The body field this module owns. Better Auth names it; so do `sign-in.mjs`, `account.mjs` and the magic-link plugin. */
const FIELD = "errorCallbackURL";

/**
 * Refuse the value, naming it.
 *
 * A `ValidationError` rather than the flat Better Auth shape the rest of this route answers in. The
 * divergence is deliberate and small: Better Auth's own origin check already refuses three of the five
 * shapes below — with a 403 and `INVALID_ERROR_CALLBACK_URL`, which says the origin was wrong when the
 * origin was fine — and the two it does *not* refuse are the two this module exists for. A message that
 * names the field and the property it broke is what gets an adopter's configuration fixed.
 */
function refuse(value: string, why: string): never {
  throw new ValidationError({
    message: "That error callback URL cannot be used.",
    action: "Pass an absolute URL, or a root-relative path — with no fragment and no `error` parameter.",
    detail: `${FIELD} ${JSON.stringify(value)}: ${why}`,
    issues: [{ path: [FIELD], message: why, code: "invalid_format" }],
  });
}

/**
 * Normalize one `errorCallbackURL`, or refuse it.
 *
 * **The caller's intent is preserved.** A root-relative input stays root-relative — this Worker's origin
 * is not necessarily the adopter's, and answering `/sign-in` as `https://this-worker/sign-in` would
 * retarget their error screen at us. An absolute one stays absolute, on its own origin. What changes is
 * only the shape: percent-encoding, dot segments and an empty trailing `?` are canonicalized, which is
 * what a browser does to the same string before it fetches it.
 *
 * **A `//host/path` input is *not* root-relative**, even though it starts with a slash. It resolves to
 * another origin, and treating it as a path would hand it this Worker's. It is parsed as an absolute URL
 * — `new URL()` alone refuses it, so it is refused here, which is what Better Auth's own origin check
 * does with it too.
 *
 * @param value The raw string from the request body.
 * @param requestUrl The absolute URL of the request carrying it, used only to resolve a root-relative
 *   path for parsing. Only `pathname` and `search` are kept from that resolution, so it never reaches
 *   the returned value.
 */
export function normalizeErrorCallbackURL(value: string, requestUrl: string): string {
  if (value === "") {
    // Better Auth skips its own origin check on a falsy value (`errorCallbackURL && validateURL(…)`) and
    // then stores it with `??`, not `||` — so `""` survives as the error URL and the redirect becomes a
    // bare `?error=<code>` resolved against the callback's own path. There is no URL to produce from it.
    refuse(value, "it is empty");
  }
  // **The raw string, not `URL.hash`.** `http://host/sign-in#` parses with an empty hash and is still the
  // bypass: the dependency concatenates the string it was given, so `…#` + `?error=x` puts the code
  // inside a fragment that `URL` then reports as `#?error=x`. Any `#` at all disqualifies the value; one
  // that is meant literally survives as `%23`, which is not a fragment and is not this check's business.
  if (value.includes("#")) {
    refuse(value, "it carries a fragment, and an `error` appended after a `#` is never read as a query");
  }

  const rootRelative = value.startsWith("/") && !value.startsWith("//");
  let url: URL;
  try {
    url = rootRelative ? new URL(value, requestUrl) : new URL(value);
  } catch {
    refuse(value, "it is neither an absolute URL nor a root-relative path");
  }

  // Appending to a URL that already answers this question is how the caller chose which code the collapse
  // read (round 2). Closed here rather than reconciled there: two `error` values is not a URL the kit
  // would ever produce, so it is not a URL the kit accepts.
  if (url.searchParams.has("error") || url.searchParams.has("error_description")) {
    refuse(value, "it already carries an `error` or `error_description` parameter, and the refusal appends one");
  }

  // `new URL` keeps a trailing empty `?` in `href` even though `search` is already "". Assigning the
  // empty search back drops it, so the value never ends in a separator with nothing after it.
  if (url.search === "") url.search = "";
  const normalized = rootRelative ? `${url.pathname}${url.search}` : url.href;

  // **The invariant, executed rather than described.** Two string properties, both about the value this
  // module is about to hand on — not a model of what the dependency will do with it. Their failure mode
  // is a 500 on something the kit produced, never a verdict on what the adopter sent.
  const conforms = !normalized.includes("#") && normalized.includes("?") === (url.search !== "");
  if (!conforms) {
    throw new InternalError({
      message: "Could not prepare the error callback URL.",
      detail: `normalizing ${FIELD} ${JSON.stringify(value)} produced ${JSON.stringify(normalized)}, which is not a shape a query can be appended to`,
    });
  }
  return normalized;
}

/**
 * The media types `getBody` decodes as JSON, copied from `better-call/dist/utils.mjs:3`.
 *
 * The structured suffix is the half a hand-written check forgets: `application/vnd.api+json` and
 * `application/ld+json` are JSON to the dependency and were not to this module. Copied rather than
 * approximated so the two can be compared character for character on a bump, and `/i` is kept even
 * though the caller lowercases first — the point is that this is the same expression, not one that
 * happens to agree.
 */
const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/** A plain keyed object, which is the only body shape `errorCallbackURL` can be a field of. */
function asFields(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

/**
 * The value Better Auth will see at `FIELD`, or `undefined` if it will see no string there.
 *
 * **The last occurrence, not the first.** `getBody` builds its object with
 * `formData.forEach((value, key) => { result[key] = … })`, so a body naming the field twice leaves the
 * *last* value — where `URLSearchParams.get` and `FormData.get` both answer the first. Guarding the
 * first would refuse a value nobody acts on and pass the one that reaches the concatenation.
 *
 * A non-string is Better Auth's own `BAD_REQUEST` (`origin-check.mjs:53`), in its own shape. Nothing
 * here improves on that, and inventing a second refusal for it would only split the contract. A
 * multipart file part arrives as a `File` and lands here for the same reason.
 */
function lastString(values: readonly unknown[]): string | undefined {
  const value = values.at(-1);
  return typeof value === "string" ? value : undefined;
}

/** Rebuild the request around a re-encoded body, keeping every header the route still needs. */
function rebuild(request: Request, body: BodyInit, contentType?: string): Request {
  const headers = new Headers(request.headers);
  // The re-encoded body is a different length, and a stale `content-length` is how a body gets truncated.
  headers.delete("content-length");
  if (contentType !== undefined) headers.set("content-type", contentType);
  return new Request(request.url, { method: request.method, headers, body });
}

/**
 * The media type without its parameters — `content-type.split(";")[0]`, lowercased.
 *
 * The same expression better-call's own media-type allow-list is written in (`utils.mjs:10`), and what
 * `Request.formData()` dispatches on. It is deliberately *not* what `getBody`'s branch predicates read,
 * and the difference between the two is the hole this module's single decoder closes: see the docblock.
 */
function essence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The incoming `content-type` with its `boundary` parameter replaced by a freshly minted one.
 *
 * **Every other parameter is kept.** `boundary` is the only one the rebuild invalidates — a `FormData`
 * body mints a fresh one and the old name is no longer anywhere in the bytes. The rest are what decided
 * which of `getBody`'s two form branches the request lands in, and a rebuild that dropped them would
 * quietly move it from one branch to the other: the same request, handed to Better Auth with its file
 * parts as `File`s instead of as strings. Dropping the header whole is the same move spelled shorter.
 */
function withBoundary(contentType: string, boundary: string): string {
  const kept = contentType
    .split(";")
    .filter((part) => !part.trim().toLowerCase().startsWith("boundary="))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return `${kept.join("; ")}; boundary=${boundary}`;
}

/**
 * Hand back the request Better Auth should see: the same one, or one whose `errorCallbackURL` is normalized.
 *
 * **The original is returned untouched whenever nothing needs doing**, which is almost every request.
 * Rebuilding a request costs a body round trip and is a second place for a header to go missing, so it
 * happens only when the field is actually present and actually changed.
 *
 * **The body is read from a clone.** A request body is a stream and Better Auth reads the original; this
 * one is consumed here.
 *
 * **Both channels, in the dependency's own order**: the router's query first, because it builds one for
 * every request, then `getBody`'s body branches in `getBody`'s order — see the module docblock on reach.
 * A body it decodes to something that is not a keyed object (`text/plain` to a string,
 * `application/octet-stream` to a buffer, an unknown type to the stream itself) carries no field to
 * guard, so it is left alone here for the same reason it is ignored there.
 */
export async function guardErrorCallbackURL(request: Request, requestUrl: string): Promise<Request> {
  // The query first, and unconditionally: the router builds `c.query` for every request, body or no
  // body, so a `return` above this line is the shape round 5 found. See the docblock.
  const guarded = guardQuery(request, requestUrl);

  // `getBody`'s own first line. A verb test would be a second rule about which requests carry bodies,
  // and the two would disagree the first time Better Auth put a body on a `PATCH`.
  if (!guarded.body) return guarded;
  const raw = guarded.headers.get("content-type") ?? "";
  const contentType = raw.toLowerCase();

  if (JSON_MEDIA_TYPE.test(contentType)) return guardJsonBody(guarded, requestUrl);
  // **One branch for two media types, because the dependency decodes them with one call.** Both of
  // `getBody`'s form branches are `await request.formData()`; they part company only afterwards, over
  // whether an entry is stringified, and `stringifyEntries` carries that in the dependency's own order.
  if (contentType.includes("application/x-www-form-urlencoded")) return guardFormBody(guarded, raw, requestUrl, true);
  if (contentType.includes("multipart/form-data")) return guardFormBody(guarded, raw, requestUrl, false);
  return guarded;
}

/**
 * The router's channel: `errorCallbackURL` as a query parameter, normalized on the URL itself.
 *
 * **Only a lone occurrence is a value.** `router.mjs:52` folds a repeated parameter into an *array*,
 * and an array is not the string `errorURL` is stored from — the same non-string case {@link lastString}
 * answers `undefined` for on the body side. Refusing it here would refuse a request Better Auth was
 * never handed the field in, which is the reaching-too-far half of the defect.
 *
 * **`searchParams`, not the raw query string.** The router reads its values off `URL.searchParams`, so
 * they are percent-decoded by the time Better Auth stores one: `%23` is a fragment there, and a guard
 * comparing raw bytes would not have seen one.
 */
function guardQuery(request: Request, requestUrl: string): Request {
  const url = new URL(request.url);
  const values = url.searchParams.getAll(FIELD);
  if (values.length !== 1) return request;
  const [value] = values;
  if (value === undefined) return request;

  const normalized = normalizeErrorCallbackURL(value, requestUrl);
  if (normalized === value) return request;
  // `set` on a lone occurrence rewrites it in place, so the adopter's other parameters keep their order.
  url.searchParams.set(FIELD, normalized);
  // The whole request, re-homed on the rebuilt URL — method, headers and an unread body come with it.
  return new Request(url, request);
}

/** `getBody`'s JSON branch: `await request.json()`. */
async function guardJsonBody(request: Request, requestUrl: string): Promise<Request> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    // A body that will not read, or will not parse, is Better Auth's refusal to write — `getBody`
    // answers `400 BAD_REQUEST` on the same bytes, and nothing reaches an endpoint to be guarded.
    return request;
  }
  const fields = asFields(body);
  if (!fields) return request;
  // `JSON.parse` has already decided what the key is, escapes and all, which is the whole of round 4's
  // first half: the field is looked up on the parsed object and never searched for in the text. One
  // candidate, not a list — a duplicate key in a JSON document is collapsed by the parser, not here —
  // but through the same tail, so the rule about what is and is not a value lives in one place.
  const value = lastString([fields[FIELD]]);
  if (value === undefined) return request;

  const normalized = normalizeErrorCallbackURL(value, requestUrl);
  if (normalized === value) return request;
  // Re-encoded through `JSON.stringify`, so an escaped key is written back plainly. Same object to
  // `JSON.parse`, and still JSON under whatever `+json` media type the caller sent.
  return rebuild(request, JSON.stringify({ ...fields, [FIELD]: normalized }));
}

/**
 * `getBody`'s two form branches, which are one decoder.
 *
 * `request.formData()` accepts both encodings and dispatches on the media type's essence, exactly as
 * the dependency's own call does — so there is no second predicate here to disagree with the first.
 *
 * @param contentType The header as it arrived, in its original case. The re-encode reads it, and a
 *   lowercased copy would go back on the wire changing a `boundary` the body spells in mixed case.
 * @param stringifyEntries Whether the dependency's chosen branch stringifies its entries. True for
 *   `application/x-www-form-urlencoded`, which writes `result[key] = value.toString()` — so a file part
 *   reaches Better Auth as `"[object File]"`, a string it acts on. False for `multipart/form-data`,
 *   which leaves a `File` for Better Auth's own `BAD_REQUEST`. It is the one thing the branches do
 *   differently, and it is read off the same predicate in the same order.
 */
async function guardFormBody(
  request: Request,
  contentType: string,
  requestUrl: string,
  stringifyEntries: boolean,
): Promise<Request> {
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    // A body that will not decode under the media type it claims is better-call's refusal to write, the
    // same way an unparseable JSON document is: nothing reaches an endpoint to be guarded.
    return request;
  }
  const entries = form.getAll(FIELD);
  const value = lastString(stringifyEntries ? entries.map((entry) => entry.toString()) : entries);
  if (value === undefined) return request;

  const normalized = normalizeErrorCallbackURL(value, requestUrl);
  if (normalized === value) return request;
  // `set` collapses every occurrence to one, which is exactly what the dependency would have read off
  // the original: the last value, and only it.
  form.set(FIELD, normalized);
  return reencodeForm(request, contentType, form);
}

/**
 * Write a decoded form back out under the media type it arrived as.
 *
 * The essence decides, because it is what decoded the body and what will decode it again — not the
 * branch predicate, which may have been satisfied by a parameter. A body whose essence is urlencoded
 * goes back as a query string under the header it came with; a multipart one is re-encoded by
 * `FormData`, which mints a boundary only the constructor knows, so it is encoded once to learn the
 * name and the header is rewritten around it.
 */
async function reencodeForm(request: Request, contentType: string, form: FormData): Promise<Request> {
  if (essence(contentType) !== "multipart/form-data") {
    const params = new URLSearchParams();
    for (const [name, entry] of form) params.append(name, entry.toString());
    return rebuild(request, params.toString());
  }
  const encoded = new Request(request.url, { method: "POST", body: form });
  const boundary = boundaryOf(encoded.headers.get("content-type") ?? "");
  if (boundary === undefined) {
    throw new InternalError({
      message: "Could not prepare the error callback URL.",
      detail: `re-encoding a multipart body to normalize ${FIELD} produced no boundary: ${JSON.stringify(encoded.headers.get("content-type"))}`,
    });
  }
  return rebuild(request, await encoded.arrayBuffer(), withBoundary(contentType, boundary));
}

/** The `boundary` parameter of a `content-type`, read off one `FormData` has just generated. */
function boundaryOf(contentType: string): string | undefined {
  for (const part of contentType.split(";")) {
    const trimmed = part.trim();
    if (trimmed.toLowerCase().startsWith("boundary=")) return trimmed.slice("boundary=".length);
  }
  return undefined;
}
