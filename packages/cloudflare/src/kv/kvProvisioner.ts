// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { cloudflareRequest, decodeResponse, isNotFoundError } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** A KV namespace's identity, decoded from the create response. */
export const KVNamespaceInfo = z
  .object({
    id: z.string().describe("The CF-assigned namespace id used to address the namespace."),
    title: z.string().describe("The namespace title."),
  })
  .describe("A Cloudflare KV namespace's identity, as returned by the create endpoint.");
export type KVNamespaceInfo = z.output<typeof KVNamespaceInfo>;

/**
 * Account-level KV control plane: **create and delete namespaces**. Customers use this to stand up
 * and tear down per-environment KV namespaces (e.g. ephemeral staging), and `pithy add`-driven
 * provisioning uses it to create each environment's namespaces. Addressed by account — unlike
 * {@link CloudflareKVManager}, which targets one namespace id for key reads/writes.
 */
export class CloudflareKVProvisioner extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare KV (control plane)";
  }

  /** Prove access by listing namespaces — a read, never a destructive create/delete. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().kv.namespaces.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }

  /** Find a namespace by exact title in the account, or `null` — for idempotent provisioning. */
  async findNamespaceByTitle(title: string): Promise<KVNamespaceInfo | null> {
    return cloudflareRequest(`find KV namespace ${title}`, async () => {
      for await (const ns of this.getClient().kv.namespaces.list({ account_id: this.accountId })) {
        const parsed = KVNamespaceInfo.safeParse(ns);
        if (parsed.success && parsed.data.title === title) return parsed.data;
      }
      return null;
    });
  }

  /** List every namespace in the account — for prefix-scan reconcile teardown. */
  async listNamespaces(): Promise<KVNamespaceInfo[]> {
    return cloudflareRequest("list KV namespaces", async () => {
      const namespaces: KVNamespaceInfo[] = [];
      for await (const ns of this.getClient().kv.namespaces.list({ account_id: this.accountId })) {
        const parsed = KVNamespaceInfo.safeParse(ns);
        if (parsed.success) namespaces.push(parsed.data);
      }
      return namespaces;
    });
  }

  /** Create a KV namespace by title; returns its id and title. */
  async createNamespace(title: string): Promise<KVNamespaceInfo> {
    const response = await cloudflareRequest(`create KV namespace ${title}`, () =>
      this.getClient().kv.namespaces.create({ account_id: this.accountId, title }),
    );
    return decodeResponse(KVNamespaceInfo, response, "KV namespace create");
  }

  /** Delete a KV namespace by id. Idempotent — a missing namespace is not an error, so teardown can re-run safely. */
  async deleteNamespace(namespaceId: string): Promise<void> {
    await cloudflareRequest(`delete KV namespace ${namespaceId}`, async () => {
      try {
        await this.getClient().kv.namespaces.delete(namespaceId, { account_id: this.accountId });
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
    });
  }
}
