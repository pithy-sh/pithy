// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { cloudflareRequest, decodeResponse } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** A D1 database's identity, decoded from the create response. */
export const D1DatabaseInfo = z
  .object({
    uuid: z.string().describe("The CF-assigned database id (a uuid) used to address the database."),
    name: z.string().describe("The database name."),
  })
  .describe("A Cloudflare D1 database's identity, as returned by the create endpoint.");
export type D1DatabaseInfo = z.output<typeof D1DatabaseInfo>;

/**
 * Account-level D1 control plane: **create and delete databases**. Customers use this to stand up
 * and tear down per-environment databases (e.g. ephemeral staging), and `pithy add secrets` uses it
 * to provision each environment's secrets D1. Addressed by account — unlike {@link CloudflareD1Manager},
 * which targets one database id for queries.
 */
export class CloudflareD1Provisioner extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare D1 (control plane)";
  }

  /** Prove access by listing databases — a read, never a destructive create/delete. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().d1.database.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }

  /** Every D1 database in the account — for prefix-scan reconcile teardown (`pithy feature destroy`). */
  async listDatabases(): Promise<D1DatabaseInfo[]> {
    return cloudflareRequest("list D1 databases", async () => {
      const databases: D1DatabaseInfo[] = [];
      for await (const db of this.getClient().d1.database.list({ account_id: this.accountId })) {
        const parsed = D1DatabaseInfo.safeParse(db);
        if (parsed.success) databases.push(parsed.data);
      }
      return databases;
    });
  }

  /** Find a database by exact name in the account, or `null` — for idempotent provisioning. */
  async findDatabaseByName(name: string): Promise<D1DatabaseInfo | null> {
    return cloudflareRequest(`find D1 database ${name}`, async () => {
      for await (const db of this.getClient().d1.database.list({ account_id: this.accountId, name })) {
        const parsed = D1DatabaseInfo.safeParse(db);
        if (parsed.success && parsed.data.name === name) return parsed.data;
      }
      return null;
    });
  }

  /** Create a D1 database by name; returns its id and name. */
  async createDatabase(name: string): Promise<D1DatabaseInfo> {
    const response = await cloudflareRequest(`create D1 database ${name}`, () =>
      this.getClient().d1.database.create({ account_id: this.accountId, name }),
    );
    return decodeResponse(D1DatabaseInfo, response, "D1 database create");
  }

  /** Delete a D1 database by id. */
  async deleteDatabase(databaseId: string): Promise<void> {
    await cloudflareRequest(`delete D1 database ${databaseId}`, () =>
      this.getClient().d1.database.delete(databaseId, { account_id: this.accountId }),
    );
  }
}
