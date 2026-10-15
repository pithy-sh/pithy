// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { cloudflareRequest, decodeResponse } from "../client/errors";

/** One OAuth scope, as Cloudflare's catalog lists it. */
export const OAuthScope = z
  .object({
    id: z.string().describe("The scope a client requests: `d1.write`."),
    name: z.string().describe("Its display name, which is the permission group's own: `D1 Write`."),
    category: z.string().optional().describe("Cloudflare's grouping, e.g. `developer_platform`."),
  })
  .describe("One scope in `GET /oauth/scopes`.");
export type OAuthScope = z.output<typeof OAuthScope>;

const ScopeList = z.object({ result: z.array(OAuthScope) });

/** The catalog's endpoint. Global: it needs authentication and no account. */
export const OAUTH_SCOPES_URL = "https://api.cloudflare.com/client/v4/oauth/scopes";

/**
 * **Cloudflare's OAuth scope catalog: every scope a third-party client may register (#759).**
 *
 * The third column of the permission table is checked against this the way the group names are checked
 * against the account, because a scope id that drifts from it is a sign-in Cloudflare refuses with
 * `invalid_scope` — at the consent screen of an adopter, rather than in this repository's CI.
 */
export async function listOAuthScopes(options: {
  apiToken: string;
  fetch?: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
}): Promise<OAuthScope[]> {
  const send = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const raw = await cloudflareRequest("list OAuth scopes", async () => {
    const response = await send(OAUTH_SCOPES_URL, { headers: { authorization: `Bearer ${options.apiToken}` } });
    return (await response.json()) as unknown;
  });
  return decodeResponse(ScopeList, raw, "oauth scopes list").result;
}
