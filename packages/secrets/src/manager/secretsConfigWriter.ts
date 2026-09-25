// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type {
  CfSecretEntry,
  CloudflareSecretsStoreManager,
} from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { ConflictError, fromZodError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { EncryptionConfig } from "../crypto/envelope";
import { masterKeySecretName } from "../provision/provisionSecrets";
import { ManagedEnvironment } from "../scope";
import { configStamp, decodeConfigStamp, encodeConfigStamp, type RotationPass } from "./configStamp";
import type { ConfigEntryFacts, ConfigWriter } from "./configWriter";

/**
 * The real {@link ConfigWriter}: edits the master-key config in CF Secrets Store over REST during
 * at-rest rotation (the binding itself is read-only), stamps the pass's provenance in the entry's
 * comment, and reads that comment back. This is the one write to CF Secrets Store that cannot run
 * locally, so it is exercised by the integration suite, not the local one.
 *
 * ## Edit-only, and why that is the fix rather than a nicety
 *
 * `putSecret` **upserts**: it looks the name up and, on a miss, creates. So a misnamed write-back
 * returned HTTP 200 and left an orphan entry in the store — the rotation believed it had persisted the
 * new key set, every row was re-encrypted under it, and the binding kept serving the old one. That is an
 * environment's secrets gone, silently, with a 200 in the log and a visible orphan nobody was looking at.
 *
 * So this writer never creates. `updateExistingSecret` resolves the entry **by the composed name the
 * binding resolves** and edits it by id, which is an endpoint that cannot create; a name with no entry is
 * `core/not_found`, and a name with several is `core/conflict`, both raised before anything is written.
 * Both are terminal under `secretsWorkflowRetry`, which is right: neither resolves by waiting, and a cron
 * retrying either forever would rewrite the wrong entry on every pass.
 *
 * `secretName` has no default on purpose: there is no safe unscoped entry name to fall back to, and a
 * default here would be a silent write to somebody else's key entry.
 */
export class SecretsStoreConfigWriter implements ConfigWriter {
  readonly #manager: CloudflareSecretsStoreManager;
  readonly entryName: string;

  constructor(manager: CloudflareSecretsStoreManager, secretName: string) {
    this.#manager = manager;
    this.entryName = secretName;
  }

  async write(config: EncryptionConfig, pass: RotationPass): Promise<void> {
    // **Validated before it is serialized, and serialized from what validated.** This is the one entry in
    // the kit whose corruption is a whole environment unable to decrypt anything, and the value crossing
    // this boundary had never been parsed. A config that will not parse is refused before any REST call.
    //
    // Not `fromZodError`, deliberately (`#386`): Zod's rendering carries the input it refused, and the
    // input here is the key set. Which field refused is the whole of what an operator needs.
    const validated = EncryptionConfig.safeParse(config);
    if (!validated.success) {
      throw new ValidationError({
        message: "The master key configuration this rotation would persist is not well formed.",
        action: "Nothing to run. The previous key stays current and the next scheduled pass starts over.",
        detail: `rotation write-back refused at: ${validated.error.issues
          .map((issue) => issue.path.join(".") || "(root)")
          .join(", ")}`,
      });
    }
    const serialized = JSON.stringify(validated.data);
    // Derived here, from the very bytes about to leave, so the comment is a claim about the value beside
    // it rather than about what a caller could repeat. A stamp that will not compose is *no* comment,
    // never a refusal: the comment verifies, the value is the key.
    const stamp = configStamp(config, pass);
    const comment = stamp === null ? null : encodeConfigStamp(stamp);
    if (comment === null) {
      await this.#manager.updateExistingSecret(this.entryName, serialized);
      return;
    }
    // Value and comment leave in one request, so the stamp accompanies the bytes it describes.
    await this.#manager.updateExistingSecret(this.entryName, serialized, comment);
  }

  async inspect(): Promise<ConfigEntryFacts | null> {
    const target = await this.#target();
    if (!target) return null;
    return {
      name: target.name,
      id: target.id,
      modifiedAt: target.modified,
      stamp: decodeConfigStamp(target.comment),
    };
  }

  /**
   * The one entry this writer may inspect, or `undefined` when there is none.
   *
   * **Several live entries of one name is a refusal, not a choice**, and it is the same refusal
   * `updateExistingSecret` raises on the write path — stated on both, because an inspection that quietly
   * picked the oldest would report facts about an entry the binding may not be reading. Which entry a
   * *binding* resolves is not a fact REST carries, so an operator settles it in the dashboard.
   */
  async #target(): Promise<CfSecretEntry | undefined> {
    const entries = await this.#manager.entriesNamed(this.entryName);
    if (entries.length <= 1) return entries[0];
    throw new ConflictError({
      message: `The Secrets Store holds ${entries.length} entries named '${this.entryName}'.`,
      action:
        "Delete the newer duplicates in the Cloudflare dashboard — provisioning leaves the oldest entry standing, and that is the one bound. Compare the created times, not the names.",
      detail: `rotation write-back: entries ${entries.map((entry) => entry.id).join(", ")} share the name '${this.entryName}'`,
    });
  }
}

/**
 * Build the at-rest rotation's config writer, targeting the **project- and env-scoped** master-key
 * entry the manager actually binds (`<project>-<env>-secrets-encryption-keys`) — never a bare default.
 * Both segments come from wrangler vars stamped at provision (`PROJECT`, `ENVIRONMENT`); they are
 * external config, so the environment is validated here via `ManagedEnvironment.parse` and the project
 * by the naming facade `masterKeySecretName` composes through (which refuses an empty or illegal one).
 *
 * Getting either wrong *was* not a failed write but a successful write to the wrong entry, because the
 * underlying put upserted. It is a refusal now (see {@link SecretsStoreConfigWriter}), and this
 * validation stays in front of it: refusing at the first pass is cheaper than refusing after a name was
 * composed from a var nobody stamped, and the name is still the only thing separating this project's key
 * from another's in one account-wide store.
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
  // **A feature's manager never writes back (#643).** It holds no Cloudflare API token and rotates nothing, so
  // branch code never holds write access to the account's one Secrets Store. Composed as an environment, it
  // would name `<project>-feature-…`, an entry every branch would write.
  if (parsed.data === FEATURE_ENVIRONMENT) {
    throw new ValidationError({
      message: "A feature's secrets manager does not rotate its key.",
      action: "Nothing to do. A feature's key is created once by pithy provision --feature and deleted with it.",
      detail: "rotation write-back: ENVIRONMENT=feature",
    });
  }
  return new SecretsStoreConfigWriter(manager, masterKeySecretName(project, parsed.data));
}
