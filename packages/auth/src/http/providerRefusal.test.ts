// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
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
 * dependency's own error tables, the dependency's own `APIError` sites on the callback's path, and the
 * kit's own `APIError` sites anywhere in this package — and requires every code any of them can put on
 * that redirect to carry a written verdict.
 *
 * **Both `APIError` scans are directory-wide, and the reach is the whole point.** `callback.mjs:239`
 * catches *anything* `handleOAuthUserInfo` throws and re-emits an `APIError`'s `code` as `?error=` and its
 * `message` as `?error_description=`. "Anything" includes a databaseHook, a plugin hook, and every helper
 * either of those reaches — so a scan pointed at one file names a class it cannot catch. An earlier draft
 * read only `../instance/auth.ts` while claiming "the kit's own `APIError` sites", and read none of
 * `better-auth`'s own at all.
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

/**
 * A `new APIError(…, { code: "…" })` site — the one shape that reaches the redirect from outside the
 * dependency's own error tables.
 *
 * `matchAll` works from a copy of the pattern, so one module-level regex is shared safely.
 */
const API_ERROR_CODE = /new APIError\([\s\S]{0,400}?code:\s*"([A-Za-z_]+)"/g;

/**
 * Every non-test TypeScript source in this package.
 *
 * A directory walk rather than a list, because the class the gate names — an `APIError` thrown from a
 * hook this capability installs — is not confined to the file that installs the hooks today, and a list
 * is a claim that goes stale the first time somebody adds a file.
 */
function kitSources(): readonly string[] {
  const root = join(dirname(import.meta.filename), "..");
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.includes(".test."))
    .map((path) => readFileSync(join(root, path), "utf8"));
}

function producers(): readonly Producer[] {
  const errors = betterAuthSource("oauth2/errors.mjs");
  const linkAccount = betterAuthSource("oauth2/link-account.mjs");
  const callback = betterAuthSource("api/routes/callback.mjs");
  const state = betterAuthSource("state.mjs");
  const oauthState = betterAuthSource("oauth2/state.mjs");
  // `handleOAuthUserInfo` validates the provider's profile through these two, and both throw `APIError`s
  // the callback turns straight into `?error=`. `internal-adapter.mjs` is on the list because the create
  // path reaches it, which is the no-row side of the branch this whole roster is about.
  const validateUserInfo = betterAuthSource("utils/validate-user-info.mjs");
  const internalAdapter = betterAuthSource("db/internal-adapter.mjs");

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
      what: "better-auth's own APIError codes on the callback's path (oauth2, utils, db)",
      codes: [linkAccount, validateUserInfo, internalAdapter].flatMap((source) => matches(source, API_ERROR_CODE)),
      floor: 10,
    },
    {
      what: "the kit's own APIError codes (every non-test source in this package)",
      codes: kitSources().flatMap((source) => matches(source, API_ERROR_CODE)),
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
  /** The callback this Worker was answering. Absolute, because a relative `Location` resolves against it. */
  const CALLBACK = "https://auth.example/auth/callback/github";

  function redirect(location: string, extra: Record<string, string> = {}): Response {
    const headers = new Headers({ location, ...extra });
    headers.append("set-cookie", "better-auth.state=; Max-Age=0; Path=/");
    headers.append("set-cookie", "better-auth.pkce=; Max-Age=0; Path=/");
    return new Response(null, { status: 302, headers });
  }

  test("a revealing code becomes the neutral one, and its description goes with it", () => {
    const collapsed = collapseProviderRefusal(
      CALLBACK,
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
    const collapsed = collapseProviderRefusal(CALLBACK, redirect("https://app.example/sign-in?error=signup_disabled"));
    expect(collapsed?.response.headers.getSetCookie()).toHaveLength(2);
  });

  test("a rostered code that travels is left exactly as it was", () => {
    // `access_denied`-shaped: the reader pressed Cancel, and a screen that says so is correct.
    expect(
      collapseProviderRefusal(CALLBACK, redirect("https://app.example/sign-in?error=state_mismatch")),
    ).toBeUndefined();
  });

  test("a completed sign-in is not a refusal, so nothing is rewritten", () => {
    expect(collapseProviderRefusal(CALLBACK, redirect("https://app.example/app"))).toBeUndefined();
  });

  test("the same redirect off the callback path is none of this module's business", () => {
    // Scoped deliberately: the capability does not acquire a header-rewriting middleware over every
    // route it serves because one route needed one.
    expect(
      collapseProviderRefusal(
        "https://auth.example/auth/sign-in/social",
        redirect("https://app.example/sign-in?error=signup_disabled"),
      ),
    ).toBeUndefined();
  });
});

describe("the two ways the collapse was walked around", () => {
  const CALLBACK = "https://auth.example/auth/callback/github";

  function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
  }

  /**
   * **Bypass 1: a relative `errorCallbackURL`.**
   *
   * Better Auth permits one and never makes it absolute. `api/middlewares/origin-check.mjs` passes
   * `allowRelativePaths: true` and `matchesOriginPattern` admits `/path?query`; `oauth2/state.mjs` stores
   * the value as a bare `z.string().optional()` with no URL validation; `redirectOnError` concatenates it
   * raw. So `{"errorCallbackURL":"/sign-in"}` yields a relative `Location` — and the first draft of the
   * collapse answered `undefined` to anything `new URL()` would not take, which handed the true code
   * straight to the browser *and* left the audit trail empty, on the one shape an attacker chooses.
   */
  test("a relative Location is collapsed, and goes back relative", () => {
    const collapsed = collapseProviderRefusal(CALLBACK, redirect("/sign-in?provider=github&error=account_not_linked"));
    expect(collapsed?.reason).toBe("account_not_linked");
    expect(collapsed?.response.headers.get("location")).toBe(
      `/sign-in?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`,
    );
  });

  test("a relative Location that carries nothing to collapse is still left alone", () => {
    expect(collapseProviderRefusal(CALLBACK, redirect("/app"))).toBeUndefined();
    expect(collapseProviderRefusal(CALLBACK, redirect("/sign-in?error=state_mismatch"))).toBeUndefined();
  });

  test("a protocol-relative Location is answered absolute, because `/path` would be another origin", () => {
    // `//app.example/sign-in` resolves to app.example. Preserving the *shape* rather than the target
    // would retarget the redirect at this Worker's own origin, which is a worse bug than the one fixed.
    expect(
      collapseProviderRefusal(CALLBACK, redirect("//app.example/sign-in?error=signup_disabled"))?.response.headers.get(
        "location",
      ),
    ).toBe(`https://app.example/sign-in?error=${NEUTRAL_PROVIDER_REFUSAL}`);
  });

  /**
   * **Bypass 2: a second `error` parameter, planted first.**
   *
   * `redirectOnError` *appends* `&error=<code>`; it does not replace. Start the flow with
   * `errorCallbackURL=https://app.example/sign-in?error=access_denied` and the answer is
   * `?error=access_denied&error=account_not_linked` — and `searchParams.get("error")` returns the first,
   * whose verdict is `collapse: false`. The caller picks which value the collapse reads, which is the
   * whole oracle back for the price of one query parameter.
   */
  test("a planted first error does not shelter a collapsing second", () => {
    const collapsed = collapseProviderRefusal(
      CALLBACK,
      redirect("https://app.example/sign-in?error=access_denied&error=account_not_linked"),
    );
    expect(collapsed?.reason).toBe("account_not_linked");
    expect(collapsed?.response.headers.get("location")).toBe(
      `https://app.example/sign-in?error=${NEUTRAL_PROVIDER_REFUSAL}`,
    );
  });

  test("a planted rostered code shelters nothing either, and the description still goes", () => {
    const collapsed = collapseProviderRefusal(
      CALLBACK,
      redirect(
        "https://app.example/sign-in?error=state_mismatch&error=EMAIL_NOT_VERIFIED&error_description=A+sentence.",
      ),
    );
    expect(collapsed?.response.headers.get("location")).toBe(
      `https://app.example/sign-in?error=${NEUTRAL_PROVIDER_REFUSAL}`,
    );
  });

  test("every collapsing code reaches the trail, not just the one that was read first", () => {
    expect(
      collapseProviderRefusal(
        CALLBACK,
        redirect("https://app.example/sign-in?error=signup_disabled&error=unable_to_create_user"),
      )?.reason,
    ).toBe("signup_disabled unable_to_create_user");
  });

  test("repeated codes that all travel are still left exactly as they were", () => {
    // The other direction: two `error` values are not on their own a reason to rewrite anything.
    expect(
      collapseProviderRefusal(CALLBACK, redirect("https://app.example/sign-in?error=access_denied&error=no_code")),
    ).toBeUndefined();
  });

  test("both bypasses at once — a relative target carrying a planted first code", () => {
    const collapsed = collapseProviderRefusal(CALLBACK, redirect("/sign-in?error=access_denied&error=signup_disabled"));
    expect(collapsed?.reason).toBe("signup_disabled");
    expect(collapsed?.response.headers.get("location")).toBe(`/sign-in?error=${NEUTRAL_PROVIDER_REFUSAL}`);
  });
});
