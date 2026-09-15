// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { secretBindingName } from "@pithy-sh/secrets/src/env/bindingName";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { VersionedSecret } from "@pithy-sh/secrets/src/secretsStore";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";

/**
 * The link-signing key: a rotatable secret in the **Cloudflare Secrets Store**, one entry per environment.
 * Email resolves it by name through its own minimal registry — `secretsStore` reads the same binding
 * whichever registry names it, so email never needs the project-wide registry to sign or verify a link.
 */
export const EMAIL_LINK_SIGNING_KEY = "email-link-signing-key";

/**
 * The binding a Worker reads the link-signing key through: `EMAIL_LINK_SIGNING_KEY` (#603). Derived, never
 * spelled — the stanza `pithy secrets provision` writes and the reader in `@pithy-sh/secrets` both call
 * `secretBindingName`, and so does this.
 */
export const EMAIL_LINK_SIGNING_KEY_BINDING = secretBindingName(EMAIL_LINK_SIGNING_KEY);

/** The minimal registry email uses to resolve its signing key. Rotatable so old links verify after rotation. */
export const emailSigningRegistry = defineSecretRegistry({
  [EMAIL_LINK_SIGNING_KEY]: {
    // **`cf-secrets-store`, because of all the kit's secrets this is the one whose loss outlives the
    // system (#596).** Lose a session secret and everyone signs in again; lose this and every link already
    // in somebody's inbox stops verifying, and nothing can reissue mail that was sent. As a `d1` row it sat
    // inside the vault — where a rollback, a `seed --redo` or a teardown agreed to by an operator reaches —
    // and on 2026-09-14 a staging rollback took it. A Secrets Store entry lives outside every D1, so none
    // of those can.
    backend: "cf-secrets-store",
    // **`environment`, never `global` — decided on #596.** Every link points at the origin that minted it,
    // so it is verified by the environment that signed it, and nothing needs a staging link to verify in
    // production. A shared key would make the boundary decorative: a staging-minted unsubscribe would be a
    // valid write into the suppression list both environments bind, recorded as production's. One entry
    // per environment, none shared. (The token's `aud` claim holds the same line if an entry is ever
    // misconfigured as shared — see `crypto/token.ts`.)
    //
    // `global` on `d1` was also the failure mode the move removes: N copies under N master keys that must
    // stay identical, where losing one could only be repaired by destroying all of them.
    scope: "environment",
    rotatable: true,
    valueType: "text",
    // Mintable for dev: the key signs links this app both mints and verifies, so any random string
    // serves. Nothing else names it, so without `devValue` the first tracked link is the first anyone
    // hears of it — and by then the mail is in an inbox.
    devValue: "random",
    // Arbitrary in production for the same reason it is arbitrary in dev: this app mints the links and
    // this app verifies them. So it is `minted` in every environment — `pithy secrets provision` creates
    // the entry when it is absent and never replaces one — and `local` to replace.
    origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
    rotation: { kind: "local" },
  },
});

/**
 * Resolve the current signing key plus every still-valid prior version. The current version is the
 * `kid` new tokens are signed with; the full version set is what `verifyToken` checks a token's `kid`
 * against, so a link minted before a rotation still verifies until its version is pruned.
 */
export async function resolveSigningKeys(
  env: SecretsStoreEnv,
): Promise<VersionedSecret<(typeof emailSigningRegistry)[typeof EMAIL_LINK_SIGNING_KEY]>> {
  const secrets = await sharedSecretsStore(env, emailSigningRegistry);
  return secrets.getVersions(EMAIL_LINK_SIGNING_KEY);
}
