import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Cloudflare } from "cloudflare";
import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "../test-utils/harness";
import { CloudflareR2Manager } from "./r2Manager";

/**
 * LIVE integration test — R2 presigned URLs. Creates a real bucket with the raw SDK, then exercises
 * the manager's presigned PUT + GET against it with a real S3 round-trip (so the SigV4 signing is
 * verified end to end), and deletes the object + bucket in teardown. Needs R2 enabled plus the S3
 * keys in `R2_CREDENTIALS`; skipped without them. See `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();
const KEY = "greeting.txt";
const PAYLOAD = "saffron payload";
const BODY = new TextEncoder().encode(PAYLOAD);

describe.skipIf(!creds.hasCreds || !creds.r2)("CloudflareR2Manager — LIVE", () => {
  const client = new Cloudflare({ apiToken: creds.apiToken });
  // Non-null inside the suite: the skipIf above guarantees creds.r2 is present.
  const r2 = creds.r2 ?? { accessKeyId: "", secretAccessKey: "" };
  const r2Config = { accountId: creds.accountId, apiToken: creds.apiToken, ...r2 };

  test("presigns a PUT + GET round-trip against a real bucket, then tears it down", async () => {
    await withThrowawayResource(
      () => client.r2.buckets.create({ account_id: creds.accountId, name: uniqueName("pithy-int-r2") }),
      async (bucket) => {
        const manager = new CloudflareR2Manager({ ...r2Config, bucketName: bucket.name ?? "" });

        // Happy path: the bucket is reachable over the CF API.
        expect(await manager.validateServiceAccess()).toBe(true);

        // Presign a PUT and upload bytes through it — exercises SigV4 signing against real R2.
        const uploadUrl = await manager.createUploadUrl(KEY, "text/plain", BODY.byteLength);
        const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: BODY });
        expect(put.ok).toBe(true);

        // Presign a GET and read it back — the decoded round-trip.
        const downloadUrl = await manager.createDownloadUrl(KEY);
        expect(await (await fetch(downloadUrl)).text()).toBe(PAYLOAD);

        // Error path: a manager pointed at a non-existent bucket fails access validation.
        const missing = new CloudflareR2Manager({ ...r2Config, bucketName: uniqueName("pithy-int-nobucket") });
        expect(await missing.validateServiceAccess()).toBe(false);
      },
      async (bucket) => {
        // R2 requires an empty bucket before delete: remove the object, then the bucket.
        const s3 = new S3Client({
          region: "auto",
          endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
        });
        await s3.send(new DeleteObjectCommand({ Bucket: bucket.name ?? "", Key: KEY })).catch(() => undefined);
        if (bucket.name) await client.r2.buckets.delete(bucket.name, { account_id: creds.accountId });
      },
    );
  });
});
