// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PermissionKey } from "@pithy-sh/cloudflare/src/tokens/permissions";
import { RUNTIME_PROFILE, RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { defineSecretRegistry, type SecretRegistryEntry } from "../registry";

/** Where a human makes a Cloudflare API token by hand, for an operator who would rather. */
const TOKEN_PAGE = "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/";

/** Where Cloudflare rolls one and hands back its successor. */
const TOKEN_ROLL = "https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/";

/** The runtime token's registry entry: a plain-text Cloudflare token, so a reader's `get` is a string. */
export type RuntimeTokenEntry = SecretRegistryEntry & { readonly valueType: "text" };

/**
 * **The one Cloudflare API token a deployed application holds, as a Worker declares it (#728).**
 *
 * Every capability whose Worker calls Cloudflare reads this one secret, so each declares it — the secrets
 * manager, media, and whatever comes next. `aggregateSecretRegistries` refuses two declarations of one
 * name that disagree on `backend`, `scope`, `valueType` or `rotatable`, so every declaration comes from
 * here: one factory, the way `@pithy-sh/storage`'s `r2CredentialsRegistry` gives every declaration of an R2
 * bundle the same axes.
 *
 * - **`cf-secrets-store`, per environment.** `pithy token mint runtime --env <env>` writes the value
 *   there, and the Worker reads it through its binding. Revoking staging's token leaves production reading.
 * - **`helped` to create, `provider` to rotate.** The kit cannot mint without a credential for the account,
 *   and it knows which grants the declaring capability needs, so `needs.cloudflare` is that capability's own
 *   `runtimePermissions`. The token itself carries the union of every composed capability's, which only the
 *   `runtime` profile knows — the mint is the profile's, and the note says so.
 */
export function runtimeTokenRegistry(
  needs: readonly PermissionKey[],
): Readonly<Record<typeof RUNTIME_TOKEN_SECRET, RuntimeTokenEntry>> {
  return defineSecretRegistry({
    [RUNTIME_TOKEN_SECRET]: {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      origin: { kind: "helped", issuer: "cloudflare", needs: { cloudflare: [...needs] }, documentation: TOKEN_PAGE },
      rotation: { kind: "provider", issuer: "cloudflare", documentation: TOKEN_ROLL },
      notes: `The one Cloudflare API token this application holds. Minted by ${commandName("token mint")} ${RUNTIME_PROFILE}.`,
    },
  });
}
