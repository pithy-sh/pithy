import type { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { masterKeySecretName } from "../provision/provisionSecrets";
import { ManagedEnvironment } from "../scope";
import type { ConfigWriter } from "./configWriter";

/** The CF Secrets Store entry that holds the master-key config. */
export const ENCRYPTION_KEYS_SECRET = "SECRETS_ENCRYPTION_KEYS";

/**
 * The real {@link ConfigWriter}: writes the master-key config back to CF Secrets Store over REST
 * during at-rest rotation (the binding itself is read-only). `putSecret` passes the prior value for
 * atomic recovery — losing this config would make every stored secret undecryptable. This is the
 * one write to CF Secrets Store that cannot run locally, so it is exercised by the integration
 * suite, not the local one.
 */
export class SecretsStoreConfigWriter implements ConfigWriter {
  readonly #manager: CloudflareSecretsStoreManager;
  readonly #secretName: string;

  constructor(manager: CloudflareSecretsStoreManager, secretName: string = ENCRYPTION_KEYS_SECRET) {
    this.#manager = manager;
    this.#secretName = secretName;
  }

  async write(value: string, previous: string): Promise<void> {
    await this.#manager.putSecret(this.#secretName, value, previous);
  }
}

/**
 * Build the at-rest rotation's config writer, targeting the **env-prefixed** master-key entry the
 * manager actually binds (`STAGING_/PRODUCTION_SECRETS_ENCRYPTION_KEYS`) — never the unprefixed
 * default. The worker reads its environment from the `ENVIRONMENT` wrangler var; that var is external
 * config, so it is validated here via `ManagedEnvironment.parse`. Without this, a rotation would
 * persist the new key set to an entry the binding never reads, and re-encrypted rows would become
 * undecryptable.
 */
export function rotationConfigWriter(
  manager: CloudflareSecretsStoreManager,
  environment: string,
): SecretsStoreConfigWriter {
  return new SecretsStoreConfigWriter(manager, masterKeySecretName(ManagedEnvironment.parse(environment)));
}
