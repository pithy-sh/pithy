// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { type AmbientEnv, ambientEnv, compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import { isContinuousIntegration } from "@pithy-sh/core/src/env/ci";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import { FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { DEV_LOGIN_CLAIM_PARAM, DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AuthWiring } from "../capability";
import { Session } from "../data/betterAuth";
import { authDatabase } from "../data/tables";
import { resolveSessionSecret } from "../instance/secrets";
import { signCookieValue, verifyDevLoginClaim } from "../seeds/devSession";
import { baseURLResolver, type ResolveBaseURL, sessionCookieName } from "./baseUrl";
import { resolveDb } from "./resolve";

/** The environments a composition mounts the dev-login route in. Everything else — `staging`, `prod` — never. */
export const DEV_LOGIN_ENVIRONMENTS: readonly string[] = [LOCAL_ENVIRONMENT, FEATURE_ENVIRONMENT];

/**
 * `GET /__pithy/dev-login` — the seeded session, as a redirect that signs the browser in.
 *
 * The seed already mints a real session row and a real signed cookie. What was missing was a way to
 * *hand it to a browser*: the artifact is a file, and the only route to a browser from a file was the
 * terminal — `document.cookie = "…"`, printed on the ready banner, pasted into a console. That line put
 * a live session token in the one place a credential must never be, which is a place people read, copy,
 * screenshot, and tee into a log. A URL carries the same credential to the same browser without it ever
 * being rendered as text.
 *
 * ## The two gates, and why they are two statements
 *
 * This route mints an authenticated session with **no credential presented**. That is the entire risk of
 * the feature, so it is refused twice, independently:
 *
 * 1. The composition's environment is neither `dev` nor `feature`.
 * 2. `CI` is set to any non-blank value — even in a `dev` composition.
 *
 * **`feature` is the one deployed environment it mounts on (#643).** A feature deployment is throwaway, owned
 * by one branch, and signed into by the people building it — and without the route, the login its seed writes
 * has nowhere to land. `staging` and `prod` never mount it: they are the list {@link DEV_LOGIN_ENVIRONMENTS}
 * leaves out, not a list it names, so a new environment is refused until somebody adds it here on purpose.
 *
 * Neither implies the other. CI runs `dev` compositions constantly (integration suites, packaging
 * checks, `pithy dev` itself), and a developer's laptop is not CI, so "not `dev`" does not cover CI and
 * "not CI" does not cover production. Written as one `||` the pair reads like a single condition, and a
 * single condition is one edit from an `&&` — with a session-minting endpoint answering as the failure
 * mode, silently. Two `if`s, two comments, two tests.
 *
 * ## And the gates are at registration
 *
 * Not inside the handler. A route that exists and refuses is one refactor away from a route that exists
 * and does not, and it is visible in the route table of a production Worker, where its presence alone is
 * a finding. The assertion the tests make is therefore about what a composition *mounts*.
 *
 * **What the CI gate can and cannot see.** In a Worker, `process.env` is the script's bindings and
 * nothing else — the shell's `CI` does not cross into workerd. `pithy dev` forwards it as a var for
 * exactly this reason, so the read is truthful for every Worker Pithy starts; a Worker started some
 * other way in CI is covered only by the environment gate. That is why there are two, and why the
 * second is the one that needs no cooperation.
 */
export function registerDevLoginRoute(
  wiring: AuthWiring,
  env: AmbientEnv = ambientEnv(),
): (app: Hono<PithyHonoEnv>) => void {
  return (app) => {
    // Gate one: the composition's environment. `undefined` — nothing stamped `ENVIRONMENT` — is neither.
    const environment = compositionEnvironment(env);
    if (environment === undefined || !DEV_LOGIN_ENVIRONMENTS.includes(environment)) return;
    // Gate two: continuous integration, independently. A `dev` composition in CI gets no route either.
    if (isContinuousIntegration(env)) return;
    // Which cookie a signed-in browser carries is the composition's, not this route's: `http` in `dev`, the
    // deployed origin's `https` on a feature (#643). Resolved from the same environment, once, here.
    const resolveBase = baseURLResolver(wiring.config.baseURL, env);
    // The claim is read here rather than inside the handler: `c.req.valid` is typed off the chain it was
    // declared on, and a handler taking a bare `Context` has no validator to read from.
    app.get(DEV_LOGIN_ROUTE, zValidator("query", DevLoginQuery, validationHook), (c) =>
      serveDevLogin(c, wiring, resolveBase, c.req.valid("query")[DEV_LOGIN_CLAIM_PARAM]),
    );
  };
}

/**
 * The refusal when there is nothing to sign in as. A 404, because the honest answer is that this
 * composition has no seeded session — not that the caller got something wrong.
 *
 * It names `pithy seed` because that is the command that mints one, and it carries no detail about what
 * was searched for: the search key is derived from the signing secret.
 *
 * **In `message`, not in `action` (#344).** `action` is the operator's field and the HTTP codec strips it,
 * because on every other route the caller is somebody who must not be handed a `pithy` command. This route
 * is the exception the gates above already make: it registers only in a `dev` composition outside CI, so
 * the browser at the other end is the developer's own. That is a decision one route makes in the open,
 * which is the opposite of a field nobody classified carrying it everywhere.
 */
function noSeededSession(): NotFoundError {
  return new NotFoundError({
    message: "No dev login has been seeded for this environment. Run pithy seed, then open this URL again.",
  });
}

/**
 * What the route takes: the claim, in the query.
 *
 * **Optional, and that is deliberate.** A required field would make a missing claim a 400 and a wrong one
 * a 404, and the difference between those two answers is exactly what this route must not tell anybody.
 * Declaring it optional puts every refusal in the handler, where there is one of them.
 *
 * Bounded because an unbounded query parameter is an unbounded read. The ceiling is far above any claim
 * this seed mints; a value past it is refused for its length, which tells the sender only about the
 * request they just made.
 */
const DevLoginQuery = z
  .object({
    [DEV_LOGIN_CLAIM_PARAM]: z
      .string()
      .max(4096)
      .optional()
      .describe("The signed claim naming the user to sign in as, as `pithy seed` wrote it into the URL."),
  })
  .describe("The dev-login route's query: a claim, or nothing and the same refusal as a wrong one.");

/**
 * Exchange a claim for a session, as a `Set-Cookie` and a redirect to `/`.
 *
 * Nothing about the cookie is logged, and nothing is written to a response body: the value exists in
 * this handler and in the browser, and in no third place. The claim that bought it is in the URL, which
 * is the one place it has to be — `dev/devLogin.ts` in the CLI carries why, and keeps it out of every
 * printed line it can.
 */
async function serveDevLogin(
  c: Context<PithyHonoEnv>,
  wiring: AuthWiring,
  resolveBase: ResolveBaseURL,
  presented: string | undefined,
): Promise<Response> {
  if (!presented) throw noSeededSession();

  const secret = await resolveSessionSecret(c.env as unknown as SecretsStoreEnv);
  const now = new Date();
  // One answer for malformed, for signed-by-another-secret, and for expired. Telling them apart would
  // make this route a probe against the running secret.
  const claim = await verifyDevLoginClaim(presented, secret, now);
  if (!claim) throw noSeededSession();

  const db = authDatabase(resolveDb(c.env, wiring.config.database));
  // The user is proved to exist rather than assumed from the claim. A claim outliving the seed that
  // named it — a reseed with a different `dev.json`, a user removed — must not mint a session pointing
  // at nobody, which `get-session` would answer `null` for while the cookie looked like a way in.
  const user = await db.selectFrom("pithyAuthUsers").select("id").where("id", "=", claim.userId).executeTakeFirst();
  if (!user) throw noSeededSession();

  /*
    A real session, minted now — `#572`.

    **Random, not derived.** The token this replaced was `dev-session-<userId>-<fingerprint>`, which made
    it reproducible across reseeds and made every dev sign-in the same row. This one is a session like any
    other: its own id, its own token, revoked on its own when somebody signs out, and leaving the claim
    that produced it untouched. Nothing about it says "seeded", because nothing about it is — a person
    opened a link and a session was created, which is what sign-in means.
  */
  const token = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + wiring.config.sessionExpiresIn * 1000);
  await db
    .insertInto("pithyAuthSessions")
    .values(
      Session.encode({
        id: crypto.randomUUID(),
        token,
        userId: claim.userId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
        ipAddress: "127.0.0.1",
        userAgent: "pithy dev login",
        deviceId: null,
        familyId: null,
        // A dev login is a real sign-in, so it is authenticated now — what the live hook stamps.
        authenticatedAt: now,
      }),
    )
    .execute();

  const value = await signCookieValue(token, secret);
  // The attributes Better Auth's own session cookie carries in this composition: `HttpOnly` (a session token
  // has no business in `document.cookie`, which is also the habit this route retires), `SameSite=Lax`, root
  // path — and the name and `Secure` the base URL's scheme decides. A `dev` base URL is `http://localhost`,
  // where a `Secure` cookie is accepted and never sent back. A feature's is its `https` workers.dev origin,
  // where Better Auth reads only the `__Secure-` name and a browser keeps that name only when `Secure` (#643).
  const protocol = new URL(resolveBase(c.req.raw)).protocol;
  const secure = protocol === "https:" ? "; Secure" : "";
  const maxAge = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  const cookie = `${sessionCookieName(protocol)}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
  // 302 to the app root rather than 200 with a page: the developer asked to be signed in, not to read a
  // confirmation, and a redirect leaves the address bar on the app instead of on this route.
  return c.body(null, 302, { "Set-Cookie": cookie, Location: "/" });
}
