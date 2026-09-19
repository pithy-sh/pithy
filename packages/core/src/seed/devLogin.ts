// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { JsonDate } from "../data/codecs";

/**
 * The dev-login artifact: the one file a seed run writes so `pithy dev` can say how to sign in.
 *
 * It lives in core because it has two ends in two packages that must not depend on each other — the
 * auth capability mints it inside its seed set, and the CLI reads it to print the ready banner. Core is
 * the seam they already share, so the shape is stated once instead of being duplicated (and drifting) at
 * both ends.
 *
 * **The file holds a live credential.** A signed claim for a local database is a way in for anyone who
 * can read it, which is why it is written under `logs/` — gitignored by the starter template, so it can
 * never be committed — and why nothing here is ever put in a `PithyError` (the payload reaches logs
 * verbatim).
 *
 * **It used to hold a session cookie, and now it holds a claim — `#572`.** The difference is what
 * survives: a cookie names a row in `pithy_auth_sessions`, so signing out of the app revoked it and the
 * dev login 404'd until somebody reseeded. A claim names a *user*, signed with the session secret, and
 * the route exchanges it for a fresh session on every open. Sign-out then revokes the session it should
 * revoke and leaves the way back in alone.
 */

/** The directory seed artifacts are written to, relative to the project root. Gitignored, so transient. */
export const SEED_ARTIFACT_DIR = "logs";

/** The dev-login file's name within {@link SEED_ARTIFACT_DIR}. The `pithy dev` banner reads it by this name. */
export const DEV_LOGIN_FILE = "dev-login.json";

/** The dev-login file's path relative to the project root — what the banner and the docs both name. */
export const DEV_LOGIN_PATH = `${SEED_ARTIFACT_DIR}/${DEV_LOGIN_FILE}`;

/**
 * The dev-login **route**: where a `dev` composition serves the seeded session as a `Set-Cookie` and a
 * redirect, so signing in is a URL rather than a value pasted into a browser console.
 *
 * It is stated here, beside the file, because the two ends are the same two packages the file already
 * had to reconcile — the auth capability registers it, and `pithy dev` opens it — and neither may
 * import the other. A second spelling in one of them is a `l` that opens a 404.
 *
 * **`__pithy/` is the namespace, and the reservation is the point.** An adopter's own routes are theirs;
 * anything the kit serves that is not part of a capability's public surface lives under this prefix, so
 * a route added here can never collide with an application path someone already shipped.
 *
 * Registered **only** in a `dev` composition, and never under CI. It mints an authenticated session for
 * whoever presents a claim this project's own secret signed, which is the whole risk of the feature and
 * the reason its gates live at registration rather than inside the handler.
 */
export const DEV_LOGIN_ROUTE = "/__pithy/dev-login";

/** The query parameter {@link DEV_LOGIN_ROUTE} takes the claim in. Spelled once, read by both ends. */
export const DEV_LOGIN_CLAIM_PARAM = "t";

/**
 * A seeded dev login — everything a browser needs to be signed in as a seeded user, and nothing else.
 * `z.input` is the JSON on disk (dates as ISO-8601 strings); `z.output` is the app shape.
 */
export const DevLogin = z
  .object({
    email: z.string().describe("The seeded user this claim signs in as. Shown on the `pithy dev` ready banner."),
    userId: z.string().describe("The seeded user's id, so a tool can correlate the login with the seeded rows."),
    claim: z
      .string()
      .describe(
        "The signed, URI-encoded claim naming the user to sign in as. A live credential for the local database — never logged, never committed, never in an error payload. **Not a session:** it names a user and the route mints a session against it, so revoking a session leaves it working.",
      ),
    expiresAt: JsonDate.describe("When the claim stops being accepted. ISO-8601 text on disk; a `Date` in app code."),
  })
  .describe("A seeded dev login: the signed claim for one seeded user, written to `logs/dev-login.json`.");
export type DevLogin = z.output<typeof DevLogin>;
