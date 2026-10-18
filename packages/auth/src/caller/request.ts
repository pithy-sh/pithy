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
 * **The key is declared here and stored by the project.** Spread {@link callerTokenRegistry} into the
 * `secrets({ registry })` call so `pithy secrets` knows it, mints it, and rotates it. The name is the join
 * key, so the trusted backend — another Worker of this project — reads the same value through the same
 * entry when it mints.
 *
 * **Read per call, not through the shared cache.** A token arrives rarely next to a session, and a key
 * read fresh is a rotation that takes effect on the next request. A request with no token reads nothing.
 */

/** The secret a caller token is signed with. One per environment, rotatable, minted by the kit. */
export const CALLER_TOKEN_SECRET = "auth-caller-token-key";

/** The registry entry for {@link CALLER_TOKEN_SECRET}. Spread it into the project's `secrets({ registry })`. */
export const callerTokenRegistry = defineSecretRegistry({
  [CALLER_TOKEN_SECRET]: {
    backend: "d1",
    scope: "environment",
    // Versioned, so a token minted a moment before a rotation still verifies during the overlap.
    rotatable: true,
    valueType: "text",
    devValue: "random",
    // The project is the issuer — nothing outside it verifies this signature — so the kit makes it and
    // replaces it, exactly as it does the session secret.
    origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
    rotation: { kind: "local" },
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
 * {@link CALLER_TOKEN_HEADER}, never from `Authorization`, which carries the backend's own session.
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
