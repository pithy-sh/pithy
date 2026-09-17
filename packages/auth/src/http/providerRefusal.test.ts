// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { collapseProviderRefusal, NEUTRAL_PROVIDER_REFUSAL, PROVIDER_REFUSAL_ROSTER } from "./providerRefusal";

/**
 * The completeness gate for `./providerRefusal`'s roster (#625).
 *
 * **This is the half that keeps the fix from being a list of two strings.** The end-to-end proof lives
 * in `providerRefusal.workers.test.ts`, and it answers *does the oracle exist today*. It cannot answer
 * *will it exist after the next `better-auth` bump*, because a code nobody has written yet produces no
 * diff in a suite that does not know to drive it. So this reads the producers themselves — the
 * dependency's own error tables and the kit's own `APIError` sites — and requires every code either of
 * them can put on that redirect to carry a written verdict.
 *
 * A dependency bump that adds a code turns this red with the code's name in the message. Somebody then
 * asks the one question the roster exists for — *could the Worker have produced this without looking in
 * its own user table* — and writes the answer down. That is the review; this is what makes it impossible
 * to skip.
 *
 * **Each scan asserts a floor.** A regex that has stopped matching finds nothing and passes everything,
 * which is the failure mode a source scan actually has. The floors are what a blinded scan trips over.
 */

const require_ = createRequire(import.meta.url);

/** Better Auth's `dist/`, found through its own export map rather than by guessing at a path. */
const DIST = dirname(dirname(require_.resolve("better-auth/oauth2")));

function betterAuthSource(file: string): string {
  return readFileSync(join(DIST, file), "utf8");
}

/** One place codes come from, what it is, and how few would mean the scan has gone blind. */
interface Producer {
  /** Where a reader goes to check this. */
  readonly what: string;
  /** The codes found. */
  readonly codes: readonly string[];
  /** The fewest this scan must find to be believed. */
  readonly floor: number;
}

function matches(source: string, pattern: RegExp, transform: (raw: string) => string = (raw) => raw): string[] {
  return [...source.matchAll(pattern)].map((match) => transform(match[1] as string));
}

function producers(): readonly Producer[] {
  const errors = betterAuthSource("oauth2/errors.mjs");
  const linkAccount = betterAuthSource("oauth2/link-account.mjs");
  const callback = betterAuthSource("api/routes/callback.mjs");
  const state = betterAuthSource("state.mjs");
  const oauthState = betterAuthSource("oauth2/state.mjs");
  // The kit's own throws. `user.create.before` and `user.update.before` both run during a callback, and
  // an `APIError` raised there reaches the browser as `?error=<code>` via `callback.mjs:240`.
  const instance = readFileSync(join(dirname(import.meta.filename), "../instance/auth.ts"), "utf8");

  return [
    {
      what: "better-auth `OAUTH_CALLBACK_ERROR_CODES` (dist/oauth2/errors.mjs)",
      codes: matches(errors, /^\t[A-Z_]+: "([a-z_]+)",?$/gm),
      floor: 13,
    },
    {
      what: "better-auth `result.error` literals (dist/oauth2/link-account.mjs)",
      // Spelled as prose and underscored on the way out, at `callback.mjs:245`.
      codes: [
        ...matches(linkAccount, /error: "([a-z ]+)"/g, (raw) => raw.split(" ").join("_")),
        ...matches(linkAccount, /redirectOnError\([^)]*?"([a-z_]+)"/g),
      ],
      floor: 5,
    },
    {
      what: "better-auth redirects built inline (dist/api/routes/callback.mjs)",
      codes: matches(callback, /error=([a-z_]+)/g),
      floor: 2,
    },
    {
      what: "better-auth `StateError` codes (dist/state.mjs, dist/oauth2/state.mjs)",
      codes: [...matches(state, /code: "([a-z_]+)"/g), ...matches(oauthState, /code = "([a-z_]+)"/g)],
      floor: 5,
    },
    {
      what: "the kit's own APIError codes (src/instance/auth.ts)",
      codes: matches(instance, /code: "([A-Z_]+)"/g),
      floor: 2,
    },
  ];
}

describe("the refusal roster covers every code that can reach the callback redirect", () => {
  test.each(producers())("$what is scanned, not assumed", ({ codes, floor }) => {
    // The scan found something. A regex that has drifted finds nothing and would otherwise pass.
    expect(codes.length).toBeGreaterThanOrEqual(floor);
  });

  test("every code any producer can emit carries a written verdict", () => {
    const unreviewed = [...new Set(producers().flatMap((producer) => producer.codes))]
      .filter((code) => PROVIDER_REFUSAL_ROSTER[code] === undefined)
      .sort();
    // The message is the whole point of the gate: it hands the next reader the codes to rule on.
    expect(unreviewed, "codes with no verdict in PROVIDER_REFUSAL_VERDICTS — decide each one").toEqual([]);
  });

  test("no verdict is written for a code nothing can emit", () => {
    // The other direction, so the roster cannot silently become a museum. A code that has disappeared
    // from the dependency is a verdict about nothing, and its `why` is a claim nobody can check.
    const emitted = new Set(producers().flatMap((producer) => producer.codes));
    expect(
      Object.keys(PROVIDER_REFUSAL_ROSTER)
        .filter((code) => !emitted.has(code))
        .sort(),
    ).toEqual([]);
  });

  test("every verdict says why, because the verdict without the reason is just a list", () => {
    for (const [code, verdict] of Object.entries(PROVIDER_REFUSAL_ROSTER)) {
      expect(verdict.why.length, `${code} has no reason`).toBeGreaterThan(40);
    }
  });
});

describe("collapsing rewrites the one header and touches nothing else", () => {
  function redirect(location: string, extra: Record<string, string> = {}): Response {
    const headers = new Headers({ location, ...extra });
    headers.append("set-cookie", "better-auth.state=; Max-Age=0; Path=/");
    headers.append("set-cookie", "better-auth.pkce=; Max-Age=0; Path=/");
    return new Response(null, { status: 302, headers });
  }

  test("a revealing code becomes the neutral one, and its description goes with it", () => {
    const collapsed = collapseProviderRefusal(
      "/auth/callback/github",
      redirect("https://app.example/sign-in?provider=github&error=EMAIL_NOT_VERIFIED&error_description=A+sentence."),
    );
    expect(collapsed?.reason).toBe("EMAIL_NOT_VERIFIED");
    expect(collapsed?.response.headers.get("location")).toBe(
      `https://app.example/sign-in?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`,
    );
  });

  test("both cookies survive as separate headers", () => {
    // Folding several Set-Cookie headers into one comma-joined value is how a browser that would have
    // accepted them silently keeps them instead — and the state cookie is expired by this very response.
    const collapsed = collapseProviderRefusal(
      "/auth/callback/github",
      redirect("https://app.example/sign-in?error=signup_disabled"),
    );
    expect(collapsed?.response.headers.getSetCookie()).toHaveLength(2);
  });

  test("a rostered code that travels is left exactly as it was", () => {
    // `access_denied`-shaped: the reader pressed Cancel, and a screen that says so is correct.
    expect(
      collapseProviderRefusal("/auth/callback/github", redirect("https://app.example/sign-in?error=state_mismatch")),
    ).toBeUndefined();
  });

  test("a completed sign-in is not a refusal, so nothing is rewritten", () => {
    expect(collapseProviderRefusal("/auth/callback/github", redirect("https://app.example/app"))).toBeUndefined();
  });

  test("the same redirect off the callback path is none of this module's business", () => {
    // Scoped deliberately: the capability does not acquire a header-rewriting middleware over every
    // route it serves because one route needed one.
    expect(
      collapseProviderRefusal("/auth/sign-in/social", redirect("https://app.example/sign-in?error=signup_disabled")),
    ).toBeUndefined();
  });
});
