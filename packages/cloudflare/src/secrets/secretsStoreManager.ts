import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import {
  CloudflareNotConfiguredError,
  CloudflareRequestError,
  cloudflareRequest,
  decodeResponse,
  reasonOf,
} from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";

/** Scopes attached to every secret we create. CF requires at least one; "workers" is the bind target. */
const DEFAULT_SCOPES = ["workers"] as const;

/**
 * One secret in the store, decoded from the CF list response. CF Secrets Store never returns
 * plaintext over REST — values are bind-only by design — so this carries only metadata. The
 * `created`/`modified` ISO strings decode through `JsonDate` to real `Date`s at the wire boundary.
 */
export const CfSecretEntry = z
  .object({
    id: z.string().describe("The CF-assigned secret identifier, used to address delete by id."),
    name: z.string().describe("The secret's name within the store (the key the CLI references)."),
    status: z.enum(["pending", "active", "deleted"]).describe("The secret's lifecycle status in the store."),
    created: JsonDate.describe("When the secret was created (ISO string on the wire, Date in app)."),
    modified: JsonDate.describe("When the secret was last modified (ISO string on the wire, Date in app)."),
  })
  .describe("A single Cloudflare Secrets Store secret's metadata (never its plaintext value).");
export type CfSecretEntry = z.output<typeof CfSecretEntry>;

/** Config for the Secrets Store manager: the shared client config plus the store it targets. */
export interface SecretsStoreManagerConfig extends CloudflareManagerConfig {
  /** The CF Secrets Store id (the REST API addresses stores by id). */
  storeId: string;
}

/**
 * Out-of-Worker access to the account-level Cloudflare Secrets Store over the REST API: provisioning
 * and audit from a CLI/CI context. Inside a Worker, secret values resolve via bindings — this manager
 * is the REST counterpart for managing the store, addressed by store id.
 *
 * CF Secrets Store does not expose secret plaintext via REST (values are bind-only by design), so
 * there is no `getSecret`. The provisioning and audit flows only need put, delete, and list.
 */
export class CloudflareSecretsStoreManager extends CloudflareManager {
  private readonly storeId: string;

  constructor(config: SecretsStoreManagerConfig) {
    super(config);
    if (!config.storeId) {
      throw new CloudflareNotConfiguredError({ detail: "Missing storeId for Secrets Store REST access." });
    }
    this.storeId = config.storeId;
  }

  getServiceType(): string {
    return "Cloudflare Secrets Store";
  }

  /** Prove access by listing the store's secrets. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.listSecrets();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Insert or update a secret. If a secret with the same name already exists it is replaced
   * (delete + create) so the new value takes effect; otherwise a fresh secret is created. The SDK's
   * `edit` endpoint does not expose `value` in its typed params, so delete-then-create is the only
   * typed path to update a value.
   *
   * Pass `previousValue` to opt into atomic recovery: when the delete-then-create dance hits a
   * transient create failure, this method attempts to restore `previousValue` so the secret is never
   * left absent from the store — for any secret whose absence is a platform-level outage. Recovery is
   * best-effort; if it also fails, a combined `cloudflare/request_failed` is raised (without either
   * plaintext value) so an operator can intervene.
   */
  async putSecret(name: string, value: string, previousValue?: string): Promise<void> {
    const existing = await this.findByName(name);

    if (existing) {
      await cloudflareRequest(`put secret ${name} (delete existing)`, () =>
        this.getClient().secretsStore.stores.secrets.delete(this.storeId, existing.id, {
          account_id: this.accountId,
        }),
      );

      // The prior entry is gone. From here a create failure leaves the store missing this secret, so
      // if the caller supplied a previous value we attempt to restore it before surfacing the error.
      try {
        await this.createSecret(name, value);
      } catch (error) {
        if (previousValue === undefined) throw error;
        await this.restorePreviousValue(name, previousValue, error);
      }
      return;
    }

    await this.createSecret(name, value);
  }

  /** Delete a secret by name. Resolves the id via `listSecrets`, then issues DELETE by id. */
  async deleteSecret(name: string): Promise<void> {
    const existing = await this.findByName(name);
    if (!existing) {
      throw new NotFoundError({
        message: `Secret '${name}' was not found in the store.`,
        detail: `delete secret ${name}: no entry with that name`,
      });
    }
    await cloudflareRequest(`delete secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.delete(this.storeId, existing.id, {
        account_id: this.accountId,
      }),
    );
  }

  /**
   * List every secret in the store. The SDK auto-paginates via `for await`, so callers receive the
   * full set in one array. Each entry is Zod-validated (`CfSecretEntry`) at the wire boundary.
   */
  async listSecrets(): Promise<CfSecretEntry[]> {
    return cloudflareRequest("list secrets", async () => {
      const out: CfSecretEntry[] = [];
      for await (const entry of this.getClient().secretsStore.stores.secrets.list(this.storeId, {
        account_id: this.accountId,
      })) {
        out.push(decodeResponse(CfSecretEntry, entry, "Secrets Store list entry"));
      }
      return out;
    });
  }

  /** Whether a secret with the given name currently exists in the store. */
  async exists(name: string): Promise<boolean> {
    return (await this.findByName(name)) !== undefined;
  }

  /** The store this manager targets and the account it lives in. */
  getSecretsStoreInfo(): { storeId: string; accountId: string } {
    return { storeId: this.storeId, accountId: this.accountId };
  }

  /** Create a single secret with the default scopes. */
  private async createSecret(name: string, value: string): Promise<void> {
    await cloudflareRequest(`create secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.create(this.storeId, {
        account_id: this.accountId,
        body: [{ name, value, scopes: [...DEFAULT_SCOPES] }],
      }),
    );
  }

  /**
   * Best-effort recovery after a failed update: re-create the secret with its prior value. Always
   * throws. On a clean restore it reports the original create failure (the value is back); if the
   * restore also fails, it raises a combined error naming both upstream failures. Neither plaintext
   * value is ever embedded — only the upstream `Error.message`s.
   */
  private async restorePreviousValue(name: string, previousValue: string, originalError: unknown): Promise<never> {
    try {
      await this.getClient().secretsStore.stores.secrets.create(this.storeId, {
        account_id: this.accountId,
        body: [{ name, value: previousValue, scopes: [...DEFAULT_SCOPES] }],
      });
    } catch (restoreError) {
      throw new CloudflareRequestError({
        message: `Failed to put secret ${name} AND failed to restore prior value.`,
        detail:
          `put secret ${name}: create failed and recovery failed — ` +
          `original=${reasonOf(originalError)}; restore=${reasonOf(restoreError)}`,
      });
    }
    throw new CloudflareRequestError({
      message: `Failed to put secret ${name}: create failed, prior value restored.`,
      detail: `put secret ${name}: create failed (${reasonOf(originalError)}); prior value restored`,
    });
  }

  private async findByName(name: string): Promise<CfSecretEntry | undefined> {
    const all = await this.listSecrets();
    return all.find((entry) => entry.name === name);
  }
}
