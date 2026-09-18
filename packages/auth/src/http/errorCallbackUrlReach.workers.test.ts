// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { beforeEach, describe, expect, test } from "vitest";
import { authDatabase } from "../data/tables";
import { type AuthInstanceDeps, makeAuth } from "../instance/auth";
import { NO_SOCIAL_PROVIDERS } from "../instance/providers";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { guardErrorCallbackURL } from "./errorCallbackUrl";

/**
 * **The guard's reach must equal the dependency's, and this is the gate that says so (#625).**
 *
 * `./errorCallbackUrl` normalizes or refuses one body field. Which requests it *looks inside* is a
 * separate claim from what it does once it has looked, and round 4 is the round where that claim was
 * wrong in two places at once: the guard tested the raw body text for the literal field name, and the
 * `content-type` for the literal string `application/json`. A `\u` escape in the key defeated the
 * first (`"\u0065rrorCallbackURL"` is the same key after `JSON.parse` and shares no byte before it),
 * and the second was defeated by two of the three branches `getBody` builds a keyed object in, and by
 * part of the third.
 *
 * ## Why this suite measures instead of listing
 *
 * A gate naming those two spellings would be the same mistake one level up — a list of what was found
 * today, green on whatever is found tomorrow. The property is a *relation between two programs*:
 *
 * > For any request, the guard reads an `errorCallbackURL` out of it **exactly when** better-call
 * > hands Better Auth one — from the body through `getBody`, or from the query through the router.
 *
 * So both sides are run, on the same bytes, and compared. The dependency's side is not modeled, not
 * enumerated and not read out of its source: it is **executed**, at the version installed, through a
 * real Better Auth instance over real D1. When a bump teaches `getBody` a new media type or a new
 * decoding, the corpus entry that both sides refuse today starts being read by one of them, and the
 * comparison goes red naming the case. That is the whole point of the shape.
 *
 * ## Both channels, because the value arrives on both
 *
 * Round 5 found the gate measuring one of the two. `errorCallbackURL` is a *query* parameter on
 * `better-auth/plugins`' own `oauthPopup()` — `oauth-popup/index.mjs:143` stores
 * `errorURL: c.query.errorCallbackURL` off a `GET` — and the router builds `c.query` for every request
 * whether or not one carries a body (`router.mjs:52`). A gate whose corpus was all bodies could not see
 * a guard that opened `if (!request.body) return request`, and did not. So a case is a request *shape*:
 * a query, a body, or both, and the dependency's side reports what each channel yielded.
 *
 * A repeat in the query is the router's own answer, not this suite's: it folds repeats into an
 * **array** (`router.mjs:54`), and an array is not the string `errorURL` is stored from. The guard has
 * to agree, which is what the duplicate-query case below is for.
 *
 * `oauthPopup()` is cited as the route that made the hole visible, and round 6 refuses that plugin at
 * composition for an unrelated reason (`../instance/refusalTransport`). The channel is the router's, not
 * that plugin's — any composed plugin may declare a `GET` query holding the field, which is why the probe
 * below is a plugin of this suite's own rather than the dependency's.
 *
 * ## The probe, and the one thing it deliberately switches off
 *
 * `reachProbe` is an ordinary Better Auth plugin endpoint, so `getBody` runs for it exactly as it runs
 * for `/sign-in/social`. It declares `allowedMediaTypes: []`, which better-call reads as *no
 * media-type filter at all* (`utils.mjs:8` tests `length > 0`), and that is the honest instrument:
 *
 * Better Auth's router config restricts its routes to `application/json`, so a form-encoded, multipart
 * or `+json` body answers `415` on `/sign-in/social` **today**. That list is configuration, not a
 * property of the guard — `better-auth/plugins/device-authorization` already ships a route that widens
 * it, an adopter's own plugin may widen any route, and the kit composes adopter plugins by design. A guard
 * whose reach depends on somebody else's allow-list is one config change away from the bypass being
 * live again, with nothing here turning red. So the measurement is taken with the filter off, against
 * the parser the filter guards, and the guard is required to match *that*.
 */

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
];

/** The instance's own origin. Every probe is same-origin, so Better Auth's origin check is not the subject. */
const ORIGIN = "http://localhost";
const PROBE_URL = `${ORIGIN}/api/auth/reach-probe`;

/**
 * The value every case carries, and it does two jobs.
 *
 * It is a fragment, so the guard must **refuse** it the moment it reads it — which makes "did the
 * guard read this request?" observable as "did it throw?" without the guard needing a test seam. And
 * it is echoed back by the probe, so "did the dependency read this request?" is the same question
 * asked of the other program.
 */
const VALUE = `${ORIGIN}/sign-in#`;

const FIELD = "errorCallbackURL";

/** What the probe endpoint reports about the request better-call handed it, one entry per channel. */
interface Seen {
  /** The value at `errorCallbackURL` in the body, iff the body is a keyed object and the value is a string. */
  body: string | null;
  /** The value at `errorCallbackURL` in `c.query`, iff the router left a string there rather than an array. */
  query: string | null;
}

/** The one rule both channels are read by: a string is a value, anything else is not one. */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A plugin whose one endpoint answers what better-call gave it, on both channels.
 *
 * `method` covers the verbs a body can travel on, because the guard's own reach over methods is part of
 * the same claim: better-call reads a body whenever `request.body` is set, and asks nothing about the
 * verb.
 *
 * **No `query` schema is declared**, deliberately. A schema would make the *validator* the thing being
 * measured — it would reject a repeated parameter before the handler saw it — where the subject is what
 * the router put in `c.query`. `oauthPopup()` declares one; an adopter's plugin need not.
 */
const reachProbe: BetterAuthPlugin = {
  id: "pithy-reach-probe",
  endpoints: {
    reachProbe: createAuthEndpoint(
      "/reach-probe",
      {
        method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        // Empty, not absent: `handler.options.metadata?.allowedMediaTypes || config?.allowedMediaTypes`
        // takes this array (`[]` is truthy) and `getBody` then skips filtering entirely. See the header.
        metadata: { allowedMediaTypes: [] },
      },
      async (ctx): Promise<Seen> => {
        const body: unknown = ctx.body;
        const fields =
          typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        return { body: asString(fields[FIELD]), query: asString(query[FIELD]) };
      },
    ),
  },
};

function instance(): ReturnType<typeof makeAuth<[BetterAuthPlugin]>> {
  const deps: AuthInstanceDeps<[BetterAuthPlugin]> = {
    db: authDatabase(env.DB),
    secret: "test-secret-please-rotate-0000000000",
    baseURL: ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [ORIGIN],
    ...NO_SOCIAL_PROVIDERS,
    sendEmail: async () => ({ delivery: "queued" as const }),
    sessionExpiresIn: 60 * 60 * 24 * 7,
    sessionUpdateAge: 60 * 60 * 24,
    verificationExpiresIn: 300,
    otpLength: 6,
    disableSignUp: false,
    providerSignUp: { google: true, apple: true, facebook: true, github: true },
    emit: async () => {},
    plugins: [reachProbe],
  };
  return makeAuth(deps);
}

/** One request shape, built twice — the two programs each consume a body, so neither may share one. */
interface Case {
  label: string;
  method?: string;
  /** The raw query string, without its `?`. A shape may carry the field here, in the body, or in both. */
  query?: string;
  contentType?: string;
  body?: BodyInit;
}

function urlFor(query: string | undefined): string {
  return query === undefined ? PROBE_URL : `${PROBE_URL}?${query}`;
}

function build({ method = "POST", query, contentType, body }: Case): Request {
  const headers = new Headers({ origin: ORIGIN });
  if (contentType !== undefined) headers.set("content-type", contentType);
  return new Request(urlFor(query), { method, headers, body });
}

/**
 * Better Auth read a string at `errorCallbackURL` in the body and its own origin check refused it.
 *
 * `origin-check.mjs:60` answers `403 INVALID_ERROR_CALLBACK_URL` before the endpoint runs, so the probe
 * never reports the value — but the refusal is proof a *string* was there to refuse, which is the whole
 * of what a reach comparison asks. It is a body verdict and only a body verdict: that middleware returns
 * early on `GET`, and it reads `body?.errorCallbackURL` with no query fallback.
 */
const REFUSED_BY_ORIGIN_CHECK = "«refused by better-auth's own origin check»";

/**
 * What better-call handed Better Auth, per channel. `null` where it handed over no string.
 *
 * **A `400` is an answer, not a broken instrument.** `getBody` refuses a body it cannot decode — a
 * truncated JSON document is `Invalid JSON in request body` — and a request refused there reaches no
 * endpoint and carries nothing on either channel, which is the same `null` the probe reports for a body
 * it read and found nothing in. `origin-check.mjs:53` answers the same `400` for a field that is
 * present and not a string, which is the same `null` for the same reason. Anything else non-2xx means
 * the probe was not routed or not allowed, and that is a defect in this file rather than a measurement:
 * it throws, so the case cannot pass by not running.
 */
async function dependencyReads(shape: Case): Promise<Seen> {
  const response = await instance().handler(build(shape));
  if (response.status === 400) return { body: null, query: null };
  if (response.status === 403) {
    const refusal = await response.json<{ code?: unknown }>();
    if (refusal.code === "INVALID_ERROR_CALLBACK_URL") return { body: REFUSED_BY_ORIGIN_CHECK, query: null };
    throw new Error(`the probe answered 403 ${String(refusal.code)}; the instrument is broken`);
  }
  if (!response.ok) {
    throw new Error(`the probe answered ${response.status}: ${await response.text()}; the instrument is broken`);
  }
  return await response.json<Seen>();
}

/** Did better-call hand Better Auth an `errorCallbackURL` string at all, on either channel? */
function handedOver(seen: Seen): boolean {
  return seen.body !== null || seen.query !== null;
}

/**
 * Whether the guard read an `errorCallbackURL` out of the same request.
 *
 * Observed through the refusal rather than through a seam: `VALUE` carries a fragment, so a guard that
 * reads it has exactly one permitted answer. Anything other than a `PithyError` — a pass-through, or a
 * thrown something-else — is reported as it happened rather than folded into `false`.
 */
async function guardReads(shape: Case): Promise<boolean> {
  const request = build(shape);
  try {
    const guarded = await guardErrorCallbackURL(request, urlFor(shape.query));
    expect(guarded, "the guard read the field and rewrote the request instead of refusing it").toBe(request);
    return false;
  } catch (error) {
    if (error instanceof PithyError) return true;
    throw error;
  }
}

const MULTIPART_BOUNDARY = "----pithy625";

function multipart(fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(
    ([name, value]) => `--${MULTIPART_BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return `${parts.join("")}--${MULTIPART_BOUNDARY}--\r\n`;
}

/** The same body, with the field sent as a *file* part — which `FormData` decodes to a `File`. */
function multipartFile(name: string, value: string): string {
  return [
    `--${MULTIPART_BOUNDARY}\r\n`,
    `content-disposition: form-data; name="${name}"; filename="f.txt"\r\n`,
    "content-type: text/plain\r\n\r\n",
    `${value}\r\n`,
    `--${MULTIPART_BOUNDARY}--\r\n`,
  ].join("");
}

/**
 * A `content-type` whose **essence** is one form encoding and which carries the other's name in a
 * parameter — the shape round 5's second hole lived in.
 *
 * better-call reads the two apart differently, and that is the whole defect: its allow-list compares
 * only the essence (`utils.mjs:10` splits on `;`), while `getBody`'s branch predicates `includes()`
 * the **whole** header, urlencoded first. So this header sends `getBody` into the urlencoded branch,
 * where the decode it performs there — `request.formData()` — reads the bytes as the multipart they
 * actually are. A guard that decoded the urlencoded branch's bytes as a query string found nothing.
 */
const MULTIPART_WEARING_URLENCODED = `multipart/form-data; note=application/x-www-form-urlencoded; boundary=${MULTIPART_BOUNDARY}`;

/**
 * The corpus.
 *
 * **Nothing here declares an expected answer**, deliberately — an entry is a request shape, and both
 * programs are asked about it. Entries the dependency ignores are as load-bearing as the ones it reads:
 * they are what catches the guard reaching *further* than the dependency, which would mean refusing
 * configurations Better Auth would never have seen the field in.
 *
 * Adding a shape is cheap and needs no verdict, which is the property that keeps this list growing
 * instead of ossifying.
 */
const CORPUS: Case[] = [
  { label: "a plain JSON body", contentType: "application/json", body: JSON.stringify({ [FIELD]: VALUE }) },
  {
    label: "a JSON body with a charset parameter",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "a JSON body whose media type is spelled in capitals",
    contentType: "APPLICATION/JSON",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "a JSON key written with a `\\u` escape",
    contentType: "application/json",
    body: `{"\\u0065rrorCallbackURL":"${VALUE}"}`,
  },
  {
    label: "a JSON key written entirely in `\\u` escapes",
    contentType: "application/json",
    body: `{"\\u0065\\u0072\\u0072\\u006frCallbackURL":"${VALUE}"}`,
  },
  {
    label: "a JSON body under a `+json` structured suffix",
    contentType: "application/vnd.api+json",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "a JSON body under `application/ld+json`",
    contentType: "application/ld+json",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "a form-encoded body",
    contentType: "application/x-www-form-urlencoded",
    body: `${FIELD}=${encodeURIComponent(VALUE)}`,
  },
  {
    label: "a form-encoded body naming the field twice",
    contentType: "application/x-www-form-urlencoded",
    body: `${FIELD}=${encodeURIComponent(`${ORIGIN}/first`)}&${FIELD}=${encodeURIComponent(VALUE)}`,
  },
  {
    label: "a multipart body",
    contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    body: multipart({ [FIELD]: VALUE }),
  },
  {
    label: "a JSON body on a PUT",
    method: "PUT",
    contentType: "application/json",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "a JSON body on a PATCH",
    method: "PATCH",
    contentType: "application/json",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "a JSON body on a DELETE",
    method: "DELETE",
    contentType: "application/json",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  // Shapes the dependency reads no keyed object out of. The guard must not read one either.
  { label: "JSON text sent as `text/plain`", contentType: "text/plain", body: JSON.stringify({ [FIELD]: VALUE }) },
  {
    label: "JSON text sent as `application/xml`",
    contentType: "application/xml",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "JSON text sent as `application/octet-stream`",
    contentType: "application/octet-stream",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  { label: "JSON text sent with no media type at all", body: JSON.stringify({ [FIELD]: VALUE }) },
  { label: "a JSON array", contentType: "application/json", body: JSON.stringify([{ [FIELD]: VALUE }]) },
  { label: "a JSON string", contentType: "application/json", body: JSON.stringify(VALUE) },
  { label: "a truncated JSON body", contentType: "application/json", body: `{"${FIELD}": ` },
  { label: "a JSON body whose value is a number", contentType: "application/json", body: `{"${FIELD}": 7}` },
  {
    label: "a JSON body naming no such field",
    contentType: "application/json",
    body: JSON.stringify({ callbackURL: VALUE }),
  },
  // The two form encodings, each wearing the other's name in a `content-type` parameter. `getBody`
  // dispatches on the whole header and decodes on the essence, so these two land in the same branch by
  // one rule and are decoded by the other.
  {
    label: "a multipart body whose media type carries the urlencoded name in a parameter",
    contentType: MULTIPART_WEARING_URLENCODED,
    body: multipart({ [FIELD]: VALUE }),
  },
  {
    label: "a form-encoded body whose media type carries the multipart name in a parameter",
    contentType: "application/x-www-form-urlencoded; note=multipart/form-data",
    body: `${FIELD}=${encodeURIComponent(VALUE)}`,
  },
  {
    label: "a multipart file part, which better-call hands over as a `File`",
    contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    body: multipartFile(FIELD, VALUE),
  },
  // The same file part, one media-type parameter away from being a string Better Auth acts on:
  // `getBody`'s urlencoded branch writes `result[key] = value.toString()`, so the `File` arrives as
  // `"[object File]"`. The guard has to read it — not because that string is dangerous, but because
  // reading it is the difference between mirroring the dependency and approximating it.
  {
    label: "a multipart file part under a media type that sends `getBody` down its stringifying branch",
    contentType: MULTIPART_WEARING_URLENCODED,
    body: multipartFile(FIELD, VALUE),
  },
  // The query channel. The router builds `c.query` for every request, body or no body.
  { label: "a GET carrying the field in the query", method: "GET", query: `${FIELD}=${encodeURIComponent(VALUE)}` },
  { label: "a GET carrying nothing at all", method: "GET" },
  {
    label: "a GET whose query names some other field",
    method: "GET",
    query: `callbackURL=${encodeURIComponent(VALUE)}`,
  },
  {
    label: "a GET whose query percent-encodes the fragment",
    method: "GET",
    query: `${FIELD}=${encodeURIComponent(ORIGIN)}%2Fsign-in%23`,
  },
  {
    label: "a GET whose query names the field twice",
    method: "GET",
    query: `${FIELD}=${encodeURIComponent(`${ORIGIN}/first`)}&${FIELD}=${encodeURIComponent(VALUE)}`,
  },
  { label: "a GET whose query carries the field with an empty value", method: "GET", query: `${FIELD}=` },
  {
    label: "a POST carrying the field in the query and nothing in its JSON body",
    query: `${FIELD}=${encodeURIComponent(VALUE)}`,
    contentType: "application/json",
    body: JSON.stringify({ callbackURL: VALUE }),
  },
  {
    label: "a POST carrying the field on both channels",
    query: `${FIELD}=${encodeURIComponent(VALUE)}`,
    contentType: "application/json",
    body: JSON.stringify({ [FIELD]: VALUE }),
  },
  {
    label: "a POST carrying the field in the query under a media type neither program reads a body from",
    query: `${FIELD}=${encodeURIComponent(VALUE)}`,
    contentType: "text/plain",
    body: "nothing to see",
  },
];

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

/** A corpus entry by label, so an assertion about one shape says so when that shape is gone. */
function shapeNamed(label: string): Case {
  const shape = CORPUS.find((entry) => entry.label === label);
  if (!shape) throw new Error(`the corpus no longer holds "${label}"; this assertion has no subject`);
  return shape;
}

describe("the guard reads an errorCallbackURL out of exactly the requests Better Auth is handed one from", () => {
  test.each(CORPUS)("$label", async (shape) => {
    const dependency = await dependencyReads(shape);
    const guard = await guardReads(shape);
    expect(
      guard,
      handedOver(dependency)
        ? `the dependency read a field the guard did not (${JSON.stringify(dependency)})`
        : "the guard reached past the dependency",
    ).toBe(handedOver(dependency));
  });

  test("and the corpus proves the instrument can tell the two apart, on each channel", async () => {
    // A comparison of two programs that both answer "no" to everything passes vacuously. This is the
    // assertion that the corpus straddles the boundary, so the cases above are measuring something —
    // and it is made per channel, because a corpus that straddled it on bodies alone is exactly the
    // corpus round 5 found: green while the query channel went unguarded end to end.
    const read = { body: [] as string[], query: [] as string[] };
    const ignored: string[] = [];
    for (const shape of CORPUS) {
      const seen = await dependencyReads(shape);
      if (seen.body !== null) read.body.push(shape.label);
      if (seen.query !== null) read.query.push(shape.label);
      if (!handedOver(seen)) ignored.push(shape.label);
    }
    expect({ body: read.body.length > 0, query: read.query.length > 0, ignored: ignored.length > 0 }).toEqual({
      body: true,
      query: true,
      ignored: true,
    });
    // Named rather than counted, so a corpus entry that silently stops being read says which one.
    expect(read.body).toContain("a plain JSON body");
    expect(read.query).toContain("a GET carrying the field in the query");
    expect(ignored).toContain("JSON text sent as `text/plain`");
  });

  test.each([
    // Reach is half the claim; reading the *same* value is the other half. A body naming the field twice
    // is where the two could differ — `URLSearchParams.get` answers the first, and better-call's
    // `formData.forEach` assignment leaves the last. Guarding the wrong one of the two would be a guard
    // that refuses a value nobody sent and passes the one that mattered.
    { label: "a form-encoded body naming the field twice", channel: "body" as const },
    // And the shape the guard's whole urlencoded decode was wrong about: the bytes are multipart, the
    // branch is the urlencoded one, and only `formData()` reads the field out of them.
    { label: "a multipart body whose media type carries the urlencoded name in a parameter", channel: "body" as const },
    { label: "a GET carrying the field in the query", channel: "query" as const },
    // The router's `c.query` is built off `URLSearchParams`, which decodes — so `%23` is a fragment by
    // the time Better Auth stores it, and a guard reading the raw query string would not have seen one.
    { label: "a GET whose query percent-encodes the fragment", channel: "query" as const },
  ])("the value the guard reads is the value the dependency would have used: $label", async ({ label, channel }) => {
    const shape = shapeNamed(label);
    expect(await dependencyReads(shape)).toMatchObject({ [channel]: VALUE });
    expect(await guardReads(shape)).toBe(true);
  });

  test("a repeated query parameter is an array to the router, and not a value to either program", async () => {
    // Not a shape the guard may improve on: `router.mjs:54` folds repeats into an array, an array is not
    // the string `errorURL` is stored from, and a guard refusing it would refuse a request Better Auth
    // was never handed the field in.
    const shape = shapeNamed("a GET whose query names the field twice");
    expect(await dependencyReads(shape)).toEqual({ body: null, query: null });
    expect(await guardReads(shape)).toBe(false);
  });
});

/**
 * Reach says which requests are looked inside. This says the request handed on is still the one the
 * dependency reads — same fields, same values, same branch of `getBody`, with only the guarded value changed.
 *
 * It matters most where the rebuild has to re-encode: a multipart body is written out with a **new**
 * boundary, so the `content-type` has to be rewritten rather than kept or dropped. Kept, it names a
 * boundary that is no longer in the body and nothing decodes. Dropped whole, every other parameter on it
 * goes too — including the one deciding which of `getBody`'s two form branches runs, which is the
 * difference between a `File` handed over as a `File` and one handed over as `"[object File]"`.
 */
describe("the request the guard hands on is the request the dependency then reads", () => {
  /** A value the guard normalizes rather than refuses, so a rebuild actually happens. */
  const NEEDS_NORMALIZING = `${ORIGIN}/sign-in?`;
  const NORMALIZED = `${ORIGIN}/sign-in`;

  async function throughGuard(shape: Case): Promise<Seen> {
    const guarded = await guardErrorCallbackURL(build(shape), urlFor(shape.query));
    const response = await instance().handler(guarded);
    if (!response.ok) {
      throw new Error(`the probe answered ${response.status}: ${await response.text()}`);
    }
    return await response.json<Seen>();
  }

  test.each([
    {
      label: "a JSON body",
      shape: {
        label: "json",
        contentType: "application/json",
        body: JSON.stringify({ [FIELD]: NEEDS_NORMALIZING, callbackURL: `${ORIGIN}/app` }),
      },
    },
    {
      label: "a form-encoded body",
      shape: {
        label: "form",
        contentType: "application/x-www-form-urlencoded",
        body: new URLSearchParams({ [FIELD]: NEEDS_NORMALIZING, callbackURL: `${ORIGIN}/app` }).toString(),
      },
    },
    {
      label: "a multipart body",
      shape: {
        label: "multipart",
        contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
        body: multipart({ [FIELD]: NEEDS_NORMALIZING, callbackURL: `${ORIGIN}/app` }),
      },
    },
    {
      label: "a multipart body under the media type that sends `getBody` down its urlencoded branch",
      shape: {
        label: "multipart-wearing-urlencoded",
        contentType: MULTIPART_WEARING_URLENCODED,
        body: multipart({ [FIELD]: NEEDS_NORMALIZING, callbackURL: `${ORIGIN}/app` }),
      },
    },
  ])("$label survives the rebuild with the value normalized", async ({ shape }) => {
    expect(await throughGuard(shape)).toEqual({ body: NORMALIZED, query: null });
  });

  test("a query the guard rewrote travels on the rebuilt URL", async () => {
    const shape: Case = { label: "query", method: "GET", query: `${FIELD}=${encodeURIComponent(NEEDS_NORMALIZING)}` };
    expect(await throughGuard(shape)).toEqual({ body: null, query: NORMALIZED });
  });

  test("a query the guard rewrote keeps the adopter's own parameters beside it", async () => {
    const shape: Case = {
      label: "query with company",
      method: "GET",
      query: `tenant=acme&${FIELD}=${encodeURIComponent(NEEDS_NORMALIZING)}&provider=github`,
    };
    const guarded = await guardErrorCallbackURL(build(shape), urlFor(shape.query));
    const search = new URL(guarded.url).searchParams;
    expect([...search]).toEqual([
      ["tenant", "acme"],
      [FIELD, NORMALIZED],
      ["provider", "github"],
    ]);
  });
});
