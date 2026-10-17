// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "@pithy-sh/core/src/cli/command";
import { ConnectionPrincipal } from "@pithy-sh/core/src/controlPlane/data/connection";
import { messageOf, PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, type CloudflareCredentials, cloudflareEnv } from "../cloudflare/config";
import { isBoundSessionToken } from "../cloudflare/session/kind";

/**
 * **Who sanctioned a credential, and the one place that is decided (#721).**
 *
 * Every registration of a management credential — a key through the dashboard's device-code flow, a key
 * the operator generated with `--public-key`, and the OIDC trust #722 adds — asks this, and records what
 * it answers as the connection's authorizing principal. A rule restated at each call site regrows wrong
 * the moment somebody adds one, so it is stated once, here.
 *
 * ## The principal is derived, never asserted
 *
 * It is the email of the signed-in Cloudflare session, read through `GET /user` with the session's own
 * token. That is the only credential in the kit that carries a person: an account token (`cfat_*`) names
 * a token, and a token name cannot depart an organization, so revoking on departure (#725) could never be
 * built on one. Cloudflare cannot be asked either — a token's record carries no creator. So nothing else
 * is accepted, and there is no flag: a principal typed by whoever holds an account token is asserted
 * rather than proven, and registering a standing management credential is a deliberate act by a person.
 *
 * ## No session, no registration — in every environment, `dev` included
 *
 * An account token, a session that yields no email, and no credential at all are each refused, naming
 * `pithy cloudflare connect`. Signing in is already the onboarding step, so it costs a `dev` run nothing in
 * practice, and every connection row names a person. CI keeps its account token for migrating and
 * deploying. It registers nothing.
 */

/** The world {@link requireRegisteringPrincipal} reads, injectable so a test needs no session on disk. */
export interface RegisteringPrincipalSeams {
  /** The credentials this run resolves, or `null` when none do. A credential fault throws as itself. */
  credentials?: () => CloudflareCredentials | null;
  /** Whether a token is the access token of the session bound here — derived, never asserted (#759). */
  isSession?: (apiToken: string) => boolean;
  /** Who the session is, from `GET /user`. */
  getUser?: (credentials: CloudflareCredentials) => Promise<{ id?: string; email?: string }>;
}

/** Options for {@link requireRegisteringPrincipal}. */
export interface RegisteringPrincipalOptions {
  /** The project's Cloudflare account, from `projectCloudflareAccount`, or `null` when it names none. */
  account: CloudflareAccountSelection | null;
}

/**
 * The credentials in force here, or `null` when nothing resolves.
 *
 * Through {@link cloudflareEnv}, so a bound profile that is signed out or expired, an exported credential
 * that disagrees with it, and an account the project does not claim are each refused in the sentence they
 * are refused in everywhere else.
 */
function resolvedCredentials(account: CloudflareAccountSelection | null): CloudflareCredentials | null {
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  return accountId === "" || apiToken === "" ? null : { accountId, apiToken };
}

/** The refusal every failure here ends in. Exit 3: the call is fine, a sign-in is owed first (#697). */
function signInFirst(message: string, detail: string): PreconditionFailedError {
  return new PreconditionFailedError({
    message,
    action: `Run ${commandName("cloudflare connect")} to sign in as yourself, then run this again. An account token deploys; it registers nothing.`,
    detail,
  });
}

/**
 * The email of the person registering a credential, from their signed-in session — or the refusal.
 *
 * Asked before anything is created, on the management client's side or the adopter's, so a refusal
 * changes nothing anywhere.
 */
export async function requireRegisteringPrincipal(
  options: RegisteringPrincipalOptions,
  seams: RegisteringPrincipalSeams = {},
): Promise<ConnectionPrincipal> {
  const credentials = (seams.credentials ?? (() => resolvedCredentials(options.account)))();
  if (credentials === null) {
    throw signInFirst(
      "Registering a connection takes a signed-in Cloudflare session.",
      "no Cloudflare credential resolved",
    );
  }

  const isSession = seams.isSession ?? ((apiToken: string) => isBoundSessionToken(apiToken));
  if (!isSession(credentials.apiToken)) {
    throw signInFirst(
      "Registering a connection takes a signed-in session, not an account token.",
      "the credential in force is not the access token of a session bound to this directory",
    );
  }

  const getUser =
    seams.getUser ?? (async (resolved: CloudflareCredentials) => (await cloudflareClients(resolved)).user().getUser());
  let user: { id?: string; email?: string };
  try {
    user = await getUser(credentials);
  } catch (error) {
    throw signInFirst("Cloudflare would not say who is signed in.", `GET /user failed: ${messageOf(error)}`);
  }

  const principal = ConnectionPrincipal.safeParse(user.email);
  if (!principal.success) {
    throw signInFirst(
      "That Cloudflare session does not name a person by email.",
      `GET /user returned ${user.email === undefined ? "no email" : "an email that does not parse"} for user ${user.id ?? "unknown"}`,
    );
  }
  return principal.data;
}
