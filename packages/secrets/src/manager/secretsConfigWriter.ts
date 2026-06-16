import type { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
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
