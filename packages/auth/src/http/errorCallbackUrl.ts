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
 * Hand back the request Better Auth should see: the same one, or one whose `errorCallbackURL` is normalized.
 *
 * **The original is returned untouched whenever nothing needs doing**, which is almost every request.
 * Rebuilding a request costs a body round trip and is a second place for a header to go missing, so it
 * happens only when the field is actually present and actually changed.
 *
 * **The body is read from a clone.** A request body is a stream and Better Auth reads the original; this
 * one is consumed here.
 */
export async function guardErrorCallbackURL(request: Request, requestUrl: string): Promise<Request> {
  if (request.method !== "POST" && request.method !== "PUT") return request;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return request;

  let raw: string;
  try {
    raw = await request.clone().text();
  } catch {
    // A body that will not read is Better Auth's refusal to write, not ours.
    return request;
  }
  // Cheap prefilter: the overwhelming majority of bodies under `basePath` do not mention the field, and
  // this spares them a parse. A body that mentions it is parsed properly below, so this can only be a
  // fast path — never the decision.
  if (!raw.includes(FIELD)) return request;

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return request;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return request;
  const value = (body as Record<string, unknown>)[FIELD];
  // A non-string is Better Auth's own `BAD_REQUEST` (`origin-check.mjs:53`), in its own shape. Nothing
  // here improves on that, and inventing a second refusal for it would only split the contract.
  if (typeof value !== "string") return request;

  const normalized = normalizeErrorCallbackURL(value, requestUrl);
  if (normalized === value) return request;

  const headers = new Headers(request.headers);
  // The re-encoded body is a different length, and a stale `content-length` is how a body gets truncated.
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({ ...(body as Record<string, unknown>), [FIELD]: normalized }),
  });
}
