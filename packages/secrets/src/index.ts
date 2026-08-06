// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The package entrypoint — the surface `pithy add secrets` wires into `pithy.config.ts`. Deliberately
 * narrow: the capability factory, the registry helper and the schemas a registry entry is written
 * against, the two accessors a Worker reads secrets through, and the table map. Every other module is
 * imported by deep path (`@pithy-sh/secrets/src/...`); this is the documented contract, not a barrel.
 *
 * It exists because `pithy add` writes `import { secrets } from "@pithy-sh/secrets/src/index";`, and
 * for a while nothing answered that specifier. `@pithy-sh/core/src/index.ts` says the same thing for
 * the same reason.
 */

export {
  isSecretsCapability,
  type SecretsCapability,
  type SecretsConfig,
  secrets,
  secretsTokenProfile,
} from "./capability";
export { type SecretsTables, secretsTables } from "./data/tables";
export {
  defineSecretRegistry,
  SecretBackend,
  type SecretName,
  type SecretRegistry,
  type SecretRegistryEntry,
  SecretScope,
  type SecretValue,
  SecretValueType,
} from "./registry";
// `SecretsAccessor` is a type here, not the class. Its constructor takes already-resolved plaintext,
// and an entrypoint that calls itself narrow has no business handing out a way to mint one over
// arbitrary values. `secretsStore` is how a Worker gets one.
export { type SecretsAccessor, secretsStore, type VersionedSecret } from "./secretsStore";
export { DEFAULT_SECRETS_CACHE_TTL_SECONDS, sharedSecretsStore } from "./sharedSecretsStore";
