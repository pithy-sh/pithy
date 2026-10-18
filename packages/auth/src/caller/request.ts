// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { secretsStore } from "@pithy-sh/secrets/src/secretsStore";
import type { Context } from "hono";
import { CALLER_TOKEN_HEADER, type CallerTokenVerdict, verifyCallerToken } from "./token";

/**
 * **The caller token, verified off a request, with its key read the one way a secret is read (#560).**
 *
 * This is what a `resolveScopes` calls. It reads the token from {@link CALLER_TOKEN_HEADER} and the key
 * from `@pithy-sh/secrets` — `secretsStore(env, registry)`, never `env.X` — and hands both to
 * `verifyCallerToken`.
 *
 * ```ts
 * auth({
 *   baseURL: PUBLIC_ORIGIN,
 *   resolveScopes: async (c) =>
 *     (await verifyCallerRequest(c, { audience: PUBLIC_ORIGIN })).trusted ? ["leaderboard:submit"] : [],
 * })
 * ```
 *
 * **The key is declared here and supplied by the operator.** Spread {@link callerTokenRegistry} into the
 * `secrets({ registry })` call so `pithy secrets` knows it. The kit does not mint it: the backend that signs
 * with it is the one that needs this option, a backend outside Cloudflare, and nothing in the kit hands a
 * minted value back out. So the operator generates one value, stores it with the backend, and writes the
 * same value here with `pithy secrets create`. A Worker that could read this store would be a Worker of
 * this project, and that one calls over a service binding instead.
 *
 * **Read per call, not through the shared cache.** A token arrives rarely next to a session, and a key
 * read fresh is a rotation that takes effect on the next request. A request with no token reads nothing.
 */

/** The secret a caller token is signed with. One per environment, supplied by the operator. */
export const CALLER_TOKEN_SECRET = "auth-caller-token-key";

/** Where an operator is told how to make the caller-token key, hand it to the backend, and replace it. */
export const CALLER_TOKEN_KEY_PAGE =
  "https://github.com/pithy-sh/pithy/blob/main/packages/auth/docs/server-authoritative.md#the-signing-key";

/** The registry entry for {@link CALLER_TOKEN_SECRET}. Spread it into the project's `secrets({ registry })`. */
export const callerTokenRegistry = defineSecretRegistry({
  [CALLER_TOKEN_SECRET]: {
    backend: "d1",
    scope: "environment",
    // Tracked for age, so `pithy secrets ls --check` says when it is due. Replacing it is the operator's.
    rotatable: true,
    valueType: "text",
    // Obtained, not minted, and replaced by hand. Two parties hold this value — the Worker that verifies
    // and the backend that signs — and the backend is outside the project. A kit-minted value would be one
    // that backend could never learn, and a kit rotation would change it under the backend without a word.
    origin: { kind: "obtained", issuer: "other", documentation: CALLER_TOKEN_KEY_PAGE },
    rotation: { kind: "manual", issuer: "other", documentation: CALLER_TOKEN_KEY_PAGE },
  },
});

/** What {@link verifyCallerRequest} takes. */
export interface VerifyCallerRequestOptions {
  /** This Worker's own public origin — the `baseURL` handed to `auth()`. Never read off the request. */
  audience: string;
  /** A tighter lifetime ceiling than the kit's fifteen minutes. */
  maxLifetimeSeconds?: number;
}

/**
 * Verify the caller token on this request. `absent` when there is none — read only from
 * {@link CALLER_TOKEN_HEADER}, never from `Authorization`, which carries the player's forwarded session.
 */
export async function verifyCallerRequest(
  c: Context<PithyHonoEnv>,
  options: VerifyCallerRequestOptions,
): Promise<CallerTokenVerdict> {
  const token = c.req.header(CALLER_TOKEN_HEADER);
  if (token === undefined || token === "") return { trusted: false, reason: "absent" };
  const secrets = await secretsStore(c.env as unknown as SecretsStoreEnv, callerTokenRegistry);
  return verifyCallerToken(token, {
    keys: secrets.getVersions(CALLER_TOKEN_SECRET),
    audience: options.audience,
    ...(options.maxLifetimeSeconds === undefined ? {} : { maxLifetimeSeconds: options.maxLifetimeSeconds }),
  });
}
