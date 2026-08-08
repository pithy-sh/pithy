// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { cloudflareRequest, decodeResponse } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/**
 * The **account-level** view of Cloudflare Secrets Store: which stores exist, and nothing else.
 *
 * Its sibling {@link CloudflareSecretsStoreManager} is addressed *by store id* — it demands one in its
 * constructor, because every operation it has is inside a store. That is the right shape for putting and
 * deleting secrets and the wrong shape for the one question asked before any store id is known: which
 * store does this account have?
 *
 * **One store per account**, which is what makes the answer usable at all. `pithy add secrets` resolves
 * the id here, once, at provisioning time, and writes it into `<config>/cloudflare.json` — so every later
 * run is a plain file read. Discovery on every invocation was considered and rejected (#182): a CLI that
 * cannot run offline because it has to ask Cloudflare where its own store is has lost more than the key
 * was costing.
 */

/**
 * One store in the account, decoded from the CF list response.
 *
 * Metadata only — a store holds secrets whose plaintext the REST API never returns. The `created` and
 * `modified` ISO strings decode through `JsonDate` at the wire boundary, as every other response here
 * does, so nothing downstream parses a date string a second time.
 */
export const CfSecretsStore = z
  .object({
    id: z.string().describe("The CF-assigned store identifier — the value that becomes SECRETS_STORE_ID."),
    name: z.string().describe("The store's display name, for naming it back to an operator who has two."),
    created: JsonDate.describe("When the store was created (ISO string on the wire, Date in app)."),
    modified: JsonDate.describe("When the store was last modified (ISO string on the wire, Date in app)."),
  })
  .describe("A single Cloudflare Secrets Store's metadata. Never a secret, and never a secret's value.");
export type CfSecretsStore = z.output<typeof CfSecretsStore>;

/** Account-level Secrets Store operations: listing the account's stores. Addressed by account, not store. */
export class CloudflareSecretsStoresManager extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare Secrets Store (account)";
  }

  /** Prove access by listing the account's stores. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.listStores();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every Secrets Store in the account. The SDK auto-paginates via `for await`, so a caller receives
   * the full set in one array, and each entry is Zod-validated at the wire boundary.
   *
   * **Returns the list, never a choice.** Cloudflare permits one store per account, so the ordinary
   * answer has exactly one element — but "ordinarily one" is not "always one", and picking the first of
   * two would be guessing which store holds an adopter's production secrets. The caller decides, and the
   * only correct decision for two is to refuse and name them.
   */
  async listStores(): Promise<CfSecretsStore[]> {
    return cloudflareRequest("list secrets stores", async () => {
      const out: CfSecretsStore[] = [];
      for await (const store of this.getClient().secretsStore.stores.list({ account_id: this.accountId })) {
        out.push(decodeResponse(CfSecretsStore, store, "Secrets Store list entry"));
      }
      return out;
    });
  }
}
