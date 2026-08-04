// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { CloudflareNotConfiguredError, cloudflareRequest, decodeResponse } from "../client/errors";
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
   * Insert or update a secret. An existing entry is updated in place via `edit`; otherwise a fresh
   * secret is created.
   *
   * `edit` is what makes this safe. The old value is overwritten, never deleted first, so a failed
   * update leaves the prior value intact and bound — there is no window where the secret is absent
   * from the store (which, for a secret like the master encryption key, is a platform-level outage).
   * Scopes are re-sent so an entry converges on the same shape whichever branch wrote it.
   */
  async putSecret(name: string, value: string): Promise<void> {
    const existing = await this.findByName(name);
    if (!existing) {
      await this.createSecret(name, value);
      return;
    }

    await cloudflareRequest(`put secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.edit(existing.id, {
        account_id: this.accountId,
        store_id: this.storeId,
        value,
        scopes: [...DEFAULT_SCOPES],
      }),
    );
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
      this.getClient().secretsStore.stores.secrets.delete(existing.id, {
        account_id: this.accountId,
        store_id: this.storeId,
      }),
    );
  }

  /**
   * Delete a secret, treating an absent one as already done.
   *
   * The typed not-found on {@link deleteSecret} is right for a caller that named a specific secret and
   * needs to hear it was not there. It is wrong for anything reconciling toward absence — teardown, a
   * reaper, a re-run of a provisioning step — where "gone" is the goal and a second delete is a no-op,
   * not a failure. Two callers race on the store all the time: another runner's sweep, or a listing that
   * has not caught up.
   *
   * Given as its own method rather than a flag, so which semantics a call site wants is legible at the
   * call site. The alternative every caller reaches for otherwise is `.catch(() => {})`, which also
   * swallows the auth failure and the outage — and a teardown that swallows is how debris becomes
   * permanent with no signal at all.
   */
  async deleteSecretIfPresent(name: string): Promise<boolean> {
    const existing = await this.findByName(name);
    if (!existing) return false;
    await cloudflareRequest(`delete secret ${name}`, () =>
      this.getClient().secretsStore.stores.secrets.delete(existing.id, {
        account_id: this.accountId,
        store_id: this.storeId,
      }),
    );
    return true;
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

  private async findByName(name: string): Promise<CfSecretEntry | undefined> {
    const all = await this.listSecrets();
    return all.find((entry) => entry.name === name);
  }
}
