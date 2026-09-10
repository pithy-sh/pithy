// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Mint the short-lived GitHub OIDC token that proves a delivery came from this repository's release job.
 *
 * ## No secret exists, on either side
 *
 * The release job already holds `id-token: write` for npm trusted publishing. That permission makes
 * GitHub inject two variables into every step — `ACTIONS_ID_TOKEN_REQUEST_URL` and
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN` — and a `GET` against the first, bearing the second, returns a JWT
 * GitHub signed. The dashboard fetches GitHub's published keys and checks the claims.
 *
 * So `release.yml`'s header keeps saying what npm trusted publishing bought it: no `NPM_TOKEN`, no
 * secret in this repository at all. Neither of those two variables is a repository secret — they are
 * minted per run, injected by the runner, and expire in minutes. Nobody types either of them, and there
 * is nothing to rotate on two sides.
 *
 * ## `audience` is the whole point of taking one
 *
 * The endpoint mints a token for whatever audience it is asked for, which is what lets a caller take one
 * token per destination. A token minted for staging then carries `aud: <staging origin>` and a
 * production verifier refuses it — the narrow credential, not merely the short-lived one. See
 * `post.ts` §Audience for why that is worth the second request.
 *
 * ## What may reach a public log
 *
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is a credential for the minting endpoint, and this file is the only
 * place it is read. No message here interpolates it, and the one string that is not ours — the
 * endpoint's own rejection body — is redacted of it before being quoted.
 */

/** How long to wait for the Actions token endpoint. It is local to the runner; this is a stall, not a hop. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of a rejection body to quote — enough to diagnose, not enough to be a payload. */
const REJECTION_EXCERPT = 200;

/** What the Actions token endpoint answers. Only `value` is read; `count` is not our business. */
const ActionsIdToken = z
  .object({
    value: z.string().min(1).describe("The signed JWT, sent onward as `Authorization: Bearer <value>`."),
  })
  .describe("The GitHub Actions token endpoint's answer to a request for an OIDC token.");

/** The two variables GitHub injects into a job holding `id-token: write`. Absent means no OIDC here. */
export interface ActionsOidcEnv {
  /** The runner-local endpoint that mints tokens for this job. Already carries its own query string. */
  ACTIONS_ID_TOKEN_REQUEST_URL?: string | undefined;
  /** The bearer credential for that endpoint. Minted per run, never stored, never logged. */
  ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string | undefined;
}

/**
 * Mint one token for one audience.
 *
 * A seam rather than a function reference, so a destination can be given its own token without the
 * caller knowing where tokens come from, and a test needs no runner.
 */
export type MintToken = (audience: string) => Promise<string>;

/** Everything {@link mintActionsIdToken} needs. */
export interface MintOptions {
  /** The audience to mint for — this destination's origin, never a value shared with another. */
  audience: string;
  /** The environment the runner's two variables are read from. */
  env: ActionsOidcEnv;
  /** Transport seam, so a test needs no network. */
  fetch?: typeof fetch;
  /** How long to wait before giving up. */
  timeoutMs?: number;
}

/** Strip the request credential out of anything about to be quoted. */
function redact(text: string, credential: string): string {
  return credential === "" ? text : text.split(credential).join("[redacted]");
}

/**
 * Ask GitHub for an OIDC token naming `audience`.
 *
 * Throws on anything that is not a token: no `id-token: write`, an endpoint that refuses, a body that is
 * not the shape it promises. The caller turns that into one destination's failure — never a thrown
 * release.
 */
export async function mintActionsIdToken(options: MintOptions): Promise<string> {
  const endpoint = options.env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() ?? "";
  const credential = options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim() ?? "";
  if (endpoint === "" || credential === "") {
    throw new Error("No OIDC token endpoint in this environment. The job needs `permissions: id-token: write`.");
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL is not a URL.");
  }
  // The endpoint arrives with `?api-version=…` already on it, so the audience is set rather than appended.
  url.searchParams.set("audience", options.audience);

  const send = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await send(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const excerpt = redact(body.slice(0, REJECTION_EXCERPT).trim(), credential);
      throw new Error(`the OIDC token endpoint refused: ${response.status}${excerpt === "" ? "" : ` ${excerpt}`}`);
    }
    const parsed = ActionsIdToken.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new Error("the OIDC token endpoint answered without a token.");
    return parsed.data.value;
  } finally {
    clearTimeout(timer);
  }
}

/** The minter the release job runs with: the runner's endpoint, one token per audience asked for. */
export function actionsTokenMinter(options: Omit<MintOptions, "audience">): MintToken {
  return (audience: string) => mintActionsIdToken({ ...options, audience });
}
