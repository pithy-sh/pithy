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
 * > For any request, the guard reads an `errorCallbackURL` out of it **exactly when** better-call's
 * > `getBody` hands Better Auth one.
 *
 * So both sides are run, on the same bytes, and compared. The dependency's side is not modeled, not
 * enumerated and not read out of its source: it is **executed**, at the version installed, through a
 * real Better Auth instance over real D1. When a bump teaches `getBody` a new media type or a new
 * decoding, the corpus entry that both sides refuse today starts being read by one of them, and the
 * comparison goes red naming the case. That is the whole point of the shape.
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

/** What the probe endpoint reports about the body better-call handed it. */
interface Seen {
  /** The value at `errorCallbackURL`, iff the body is a keyed object and the value is a string. */
  value: string | null;
}

/**
 * A plugin whose one endpoint answers what `getBody` gave it.
 *
 * `method` covers the verbs a body can travel on, because the guard's own reach over methods is part of
 * the same claim: better-call reads a body whenever `request.body` is set, and asks nothing about the
 * verb.
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
        if (typeof body !== "object" || body === null || Array.isArray(body)) return { value: null };
        const value = (body as Record<string, unknown>)[FIELD];
        return { value: typeof value === "string" ? value : null };
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
    sendEmail: async () => {},
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
  contentType?: string;
  body?: BodyInit;
}

function build({ method = "POST", contentType, body }: Case): Request {
  const headers = new Headers({ origin: ORIGIN });
  if (contentType !== undefined) headers.set("content-type", contentType);
  return new Request(PROBE_URL, { method, headers, body });
}

/**
 * What better-call handed Better Auth. `null` when it handed over no keyed `errorCallbackURL` string.
 *
 * **A `400` is an answer, not a broken instrument.** `getBody` refuses a body it cannot decode — a
 * truncated JSON document is `Invalid JSON in request body` — and a request refused there reaches no
 * endpoint and carries no field, which is the same `null` the probe reports for a body it read and
 * found nothing in. Anything else non-2xx means the probe was not routed or not allowed, and that is a
 * defect in this file rather than a measurement: it throws, so the case cannot pass by not running.
 */
async function dependencyReads(shape: Case): Promise<string | null> {
  const response = await instance().handler(build(shape));
  if (response.status === 400) return null;
  if (!response.ok) {
    throw new Error(`the probe answered ${response.status}: ${await response.text()}; the instrument is broken`);
  }
  return (await response.json<Seen>()).value;
}

/**
 * Whether the guard read an `errorCallbackURL` out of the same bytes.
 *
 * Observed through the refusal rather than through a seam: `VALUE` carries a fragment, so a guard that
 * reads it has exactly one permitted answer. Anything other than a `PithyError` — a pass-through, or a
 * thrown something-else — is reported as it happened rather than folded into `false`.
 */
async function guardReads(shape: Case): Promise<boolean> {
  const request = build(shape);
  try {
    const guarded = await guardErrorCallbackURL(request, PROBE_URL);
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
  { label: "a GET carrying the field in the query", method: "GET", contentType: undefined, body: undefined },
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

describe("the guard reads an errorCallbackURL out of exactly the requests Better Auth is handed one from", () => {
  test.each(CORPUS)("$label", async (shape) => {
    const dependency = await dependencyReads(shape);
    const guard = await guardReads(shape);
    expect(
      guard,
      dependency === null ? "the guard reached past the dependency" : "the dependency read a field the guard did not",
    ).toBe(dependency !== null);
  });

  test("and the corpus proves the instrument can tell the two apart", async () => {
    // A comparison of two programs that both answer "no" to everything passes vacuously. This is the
    // assertion that the corpus straddles the boundary, so the case above is measuring something.
    const read: string[] = [];
    const ignored: string[] = [];
    for (const shape of CORPUS) {
      ((await dependencyReads(shape)) === null ? ignored : read).push(shape.label);
    }
    expect({ read: read.length > 0, ignored: ignored.length > 0 }).toEqual({ read: true, ignored: true });
    // Named rather than counted, so a corpus entry that silently stops being read says which one.
    expect(read).toContain("a plain JSON body");
    expect(ignored).toContain("JSON text sent as `text/plain`");
  });

  test("the value the guard reads is the value the dependency would have used", async () => {
    // Reach is half the claim; reading the *same* value is the other half. A form body naming the field
    // twice is where the two could differ — `URLSearchParams.get` answers the first, and better-call's
    // `formData.forEach` assignment leaves the last. Guarding the wrong one of the two would be a guard
    // that refuses a value nobody sent and passes the one that mattered.
    const shape = CORPUS.find((c) => c.label === "a form-encoded body naming the field twice");
    if (!shape) throw new Error("the duplicate-key case is gone; this assertion has no subject");
    expect(await dependencyReads(shape)).toBe(VALUE);
    expect(await guardReads(shape)).toBe(true);
  });
});
