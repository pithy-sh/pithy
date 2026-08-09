// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { type AmbientEnv, ambientEnv, compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import { isContinuousIntegration } from "@pithy-sh/core/src/env/ci";
import { fromZodError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { DEV_LOGIN_ROUTE } from "@pithy-sh/core/src/seed/devLogin";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { resolveSessionSecret } from "../instance/secrets";
import {
  DEV_SESSION_COOKIE_NAME,
  DEV_SESSION_TOKEN_PREFIX,
  secretFingerprint,
  signCookieValue,
} from "../seeds/devSession";
import { resolveDb } from "./resolve";

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
 * 1. The composition's environment is not `dev`.
 * 2. `CI` is set to any non-blank value — even in a `dev` composition.
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
    // Gate one: the composition's environment. `undefined` — nothing stamped `ENVIRONMENT` — is not `dev`.
    if (compositionEnvironment(env) !== "dev") return;
    // Gate two: continuous integration, independently. A `dev` composition in CI gets no route either.
    if (isContinuousIntegration(env)) return;
    app.get(DEV_LOGIN_ROUTE, (c) => serveDevLogin(c, wiring));
  };
}

/**
 * The seeded session row, narrowed to what handing it to a browser needs — and validated, because a D1
 * row is a boundary like any other. `z.input` is the stored row (ISO-8601 text); `z.output` the app shape.
 */
const DevSessionRow = z
  .object({
    token: z
      .string()
      .min(1)
      .describe("The seeded session's opaque token — signed with this environment's secret to make the cookie."),
    expiresAt: JsonDate.describe("When the seeded session expires. ISO-8601 text in SQLite; a `Date` here."),
  })
  .describe("A seeded dev session, narrowed to the two columns the dev-login redirect needs.");
type DevSessionRow = z.output<typeof DevSessionRow>;

/** How long the browser is told to keep the cookie: whatever is left of the seeded session, never longer. */
function maxAgeSeconds(expiresAt: Date, now: Date): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
}

/**
 * The refusal when there is nothing to sign in as. A 404, because the honest answer is that this
 * composition has no seeded session — not that the caller got something wrong.
 *
 * It names `pithy seed` because that is the command that mints one, and it carries no detail about what
 * was searched for: the search key is derived from the signing secret.
 */
function noSeededSession(): NotFoundError {
  return new NotFoundError({
    message: "No dev login has been seeded for this environment.",
    action: "Run pithy seed, then open this URL again.",
  });
}

/**
 * Serve the seeded session as a `Set-Cookie` and a redirect to `/`.
 *
 * The row is found by the prefix every seeded session carries and **verified against the current
 * signing secret's fingerprint**, which the seed puts in the token for this exact purpose. A session
 * minted before a rotation is a cookie Better Auth will reject, so handing it over would sign nobody in
 * and send the developer hunting through auth for a bug that is a stale seed. Unfound is unfound.
 *
 * Nothing about the cookie is logged, and nothing is written to a response body: the value exists in
 * this handler and in the browser, and in no third place.
 */
async function serveDevLogin(c: Context<PithyHonoEnv>, wiring: AuthWiring): Promise<Response> {
  const secret = await resolveSessionSecret(c.env as unknown as SecretsStoreEnv);
  const fingerprint = await secretFingerprint(secret);

  const db = authDatabase(resolveDb(c.env, wiring.config.database));
  const found = await db
    .selectFrom("pithyAuthSessions")
    .select(["token", "expiresAt"])
    .where("token", "like", `${DEV_SESSION_TOKEN_PREFIX}%-${fingerprint}`)
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!found) throw noSeededSession();

  const parsed = DevSessionRow.safeParse(found);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The seeded dev session is not readable.",
      action: "Run pithy seed to mint a fresh one.",
    });
  }
  const row: DevSessionRow = parsed.data;
  const maxAge = maxAgeSeconds(row.expiresAt, new Date());
  // An expired session is worse than none: the cookie looks like a way in and fails silently in the
  // browser. Same answer, same action — reseeding is what fixes both.
  if (maxAge <= 0) throw noSeededSession();

  const value = await signCookieValue(row.token, secret);
  // The attributes Better Auth's own session cookie carries in a `dev` composition: `HttpOnly` (a
  // session token has no business in `document.cookie`, which is also the habit this route retires),
  // `SameSite=Lax`, root path. No `Secure` — a `dev` base URL is `http://localhost`, and a `Secure`
  // cookie there is one the browser accepts and never sends back.
  const cookie = `${DEV_SESSION_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  // 302 to the app root rather than 200 with a page: the developer asked to be signed in, not to read a
  // confirmation, and a redirect leaves the address bar on the app instead of on this route.
  return c.body(null, 302, { "Set-Cookie": cookie, Location: "/" });
}
