import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { VersionedSecret } from "@pithy-sh/secrets/src/secretsStore";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";

/**
 * The link-signing key lives in `@pithy-sh/secrets` as a rotatable, global secret. Email resolves it
 * by name through its own minimal registry — `secretsStore` reads the same encrypted D1 row regardless
 * of which registry names it, so email never needs the project-wide registry to sign or verify a link.
 */
export const EMAIL_LINK_SIGNING_KEY = "email-link-signing-key";

/** The minimal registry email uses to resolve its signing key. Rotatable so old links verify after rotation. */
export const emailSigningRegistry = defineSecretRegistry({
  [EMAIL_LINK_SIGNING_KEY]: { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
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
