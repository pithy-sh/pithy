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
 * **The file holds a live credential.** A signed session cookie for a local database is a way in for
 * anyone who can read it, which is why it is written under `logs/` — gitignored by the starter template,
 * so it can never be committed — and why nothing here is ever put in a `PithyError` (the payload reaches
 * logs verbatim).
 */

/** The directory seed artifacts are written to, relative to the project root. Gitignored, so transient. */
export const SEED_ARTIFACT_DIR = "logs";

/** The dev-login file's name within {@link SEED_ARTIFACT_DIR}. The `pithy dev` banner reads it by this name. */
export const DEV_LOGIN_FILE = "dev-login.json";

/** The dev-login file's path relative to the project root — what the banner and the docs both name. */
export const DEV_LOGIN_PATH = `${SEED_ARTIFACT_DIR}/${DEV_LOGIN_FILE}`;

/**
 * A seeded dev login — everything a browser needs to be signed in as a seeded user, and nothing else.
 * `z.input` is the JSON on disk (dates as ISO-8601 strings); `z.output` is the app shape.
 */
export const DevLogin = z
  .object({
    email: z.string().describe("The seeded user this cookie signs in as. Shown on the `pithy dev` ready banner."),
    userId: z.string().describe("The seeded user's id, so a tool can correlate the cookie with the seeded rows."),
    cookieName: z
      .string()
      .describe("The cookie name the auth capability's session is read from, e.g. `better-auth.session_token`."),
    cookieValue: z
      .string()
      .describe(
        "The signed, URI-encoded cookie value. A live credential for the local database — never logged, never committed, never in an error payload.",
      ),
    expiresAt: JsonDate.describe("When the seeded session expires. ISO-8601 text on disk; a `Date` in app code."),
  })
  .describe("A seeded dev login: the signed session cookie for one seeded user, written to `logs/dev-login.json`.");
export type DevLogin = z.output<typeof DevLogin>;
