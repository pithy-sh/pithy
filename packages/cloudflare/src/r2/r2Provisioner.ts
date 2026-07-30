// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { cloudflareRequest, decodeResponse, isNotFoundError } from "../client/errors";
import { CloudflareManager } from "../client/manager";

/** An R2 bucket's identity, decoded from the create/list response. Buckets are addressed by name, not id. */
export const R2BucketInfo = z
  .object({
    name: z.string().describe("The bucket name — R2's sole address for a bucket (no separate uuid id)."),
  })
  .describe("A Cloudflare R2 bucket's identity, as returned by the create/list endpoints.");
export type R2BucketInfo = z.output<typeof R2BucketInfo>;

/**
 * Account-level R2 control plane: **create and delete buckets**. Customers use this to stand up and
 * tear down per-environment buckets (e.g. ephemeral staging), and worktree teardown uses it to
 * reconcile/prune feature-scoped buckets. Unlike {@link CloudflareR2Manager}, which operates within
 * one already-provisioned bucket (presigned object URLs), this manager is account-scoped and
 * addresses buckets **by name** — R2 buckets carry no separate uuid id the way D1 databases do.
 */
export class CloudflareR2Provisioner extends CloudflareManager {
  getServiceType(): string {
    return "Cloudflare R2 (control plane)";
  }

  /** Prove access by listing buckets — a read, never a destructive create/delete. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getClient().r2.buckets.list({ account_id: this.accountId });
      return true;
    } catch {
      return false;
    }
  }

  /** Find a bucket by exact name in the account, or `null` — for idempotent provisioning. */
  async findBucketByName(name: string): Promise<R2BucketInfo | null> {
    const buckets = await this.listBuckets();
    return buckets.find((bucket) => bucket.name === name) ?? null;
  }

  /**
   * List every bucket in the account. R2's bucket list is cursor-paginated (a single call returns only
   * one page, unlike D1/KV whose SDK list auto-paginates), so this drains every page via `start_after` —
   * the name of the last bucket seen — until a page comes back empty, then returns them all. Skips entries
   * with no name.
   */
  async listBuckets(): Promise<R2BucketInfo[]> {
    return cloudflareRequest("list R2 buckets", async () => {
      const buckets: R2BucketInfo[] = [];
      let startAfter: string | undefined;
      for (;;) {
        const response = await this.getClient().r2.buckets.list({
          account_id: this.accountId,
          per_page: 1000,
          ...(startAfter ? { start_after: startAfter } : {}),
        });
        const page = response.buckets ?? [];
        if (page.length === 0) break;
        for (const bucket of page) {
          const parsed = R2BucketInfo.safeParse(bucket);
          if (parsed.success) buckets.push(parsed.data);
        }
        const last = page[page.length - 1]?.name;
        if (!last || last === startAfter) break; // no name to page past, or the cursor didn't advance.
        startAfter = last;
      }
      return buckets;
    });
  }

  /** Create an R2 bucket by name; returns its name. */
  async createBucket(name: string): Promise<R2BucketInfo> {
    const response = await cloudflareRequest(`create R2 bucket ${name}`, () =>
      this.getClient().r2.buckets.create({ account_id: this.accountId, name }),
    );
    return decodeResponse(R2BucketInfo, response, "R2 bucket create");
  }

  /**
   * Delete an R2 bucket by name. Idempotent — a missing bucket is not an error, so teardown can re-run safely.
   *
   * **The bucket must already be empty.** R2 rejects the delete otherwise, and "empty" includes multipart
   * uploads that were never completed — parts nothing in this control plane can even see. Emptying is an
   * S3-protocol operation: call `CloudflareR2Manager.emptyBucket` first, which needs the S3 key pair.
   */
  async deleteBucket(name: string): Promise<void> {
    await cloudflareRequest(`delete R2 bucket ${name}`, async () => {
      try {
        await this.getClient().r2.buckets.delete(name, { account_id: this.accountId });
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
    });
  }
}
