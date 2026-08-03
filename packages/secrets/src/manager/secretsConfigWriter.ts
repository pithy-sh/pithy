// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { fromZodError } from "@pithy-sh/core/src/error/pithyError";
import { masterKeySecretName } from "../provision/provisionSecrets";
import { ManagedEnvironment } from "../scope";
import type { ConfigWriter } from "./configWriter";

/**
 * The real {@link ConfigWriter}: writes the master-key config back to CF Secrets Store over REST
 * during at-rest rotation (the binding itself is read-only). `putSecret` updates the entry in place,
 * so a failed write leaves the prior config bound and decryptable — losing this config would make
 * every stored secret undecryptable. This is the one write to CF Secrets Store that cannot run
 * locally, so it is exercised by the integration suite, not the local one.
 *
 * `secretName` has no default on purpose: there is no safe unscoped entry name to fall back to, and a
 * default here would be a silent write to somebody else's key entry.
 */
export class SecretsStoreConfigWriter implements ConfigWriter {
  readonly #manager: CloudflareSecretsStoreManager;
  readonly #secretName: string;

  constructor(manager: CloudflareSecretsStoreManager, secretName: string) {
    this.#manager = manager;
    this.#secretName = secretName;
  }

  async write(value: string): Promise<void> {
    await this.#manager.putSecret(this.#secretName, value);
  }
}

/**
 * Build the at-rest rotation's config writer, targeting the **project- and env-scoped** master-key
 * entry the manager actually binds (`<project>-<env>-secrets-encryption-keys`) — never a bare default.
 * Both segments come from wrangler vars stamped at provision (`PROJECT`, `ENVIRONMENT`); they are
 * external config, so the environment is validated here via `ManagedEnvironment.parse` and the project
 * by the naming facade `masterKeySecretName` composes through (which refuses an empty or illegal one).
 *
 * Getting either wrong is not a failed write — it is a successful write to the wrong entry. The
 * rotation would re-encrypt every row under a fresh key, persist that key where nothing binds it, and
 * leave the old key bound: every secret in the store becomes undecryptable, silently, at the next read.
 * With an unscoped name in a shared account it would be worse still — a rotation would land on another
 * project's key entry and take their store down too.
 */
export function rotationConfigWriter(
  manager: CloudflareSecretsStoreManager,
  project: string,
  environment: string,
): SecretsStoreConfigWriter {
  const parsed = ManagedEnvironment.safeParse(environment);
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The secrets manager's ENVIRONMENT var is not a managed environment.",
      action: "Redeploy the manager with `pithy secrets provision`, which stamps it.",
      detail: `rotation write-back: ENVIRONMENT=${environment}`,
    });
  }
  return new SecretsStoreConfigWriter(manager, masterKeySecretName(project, parsed.data));
}
