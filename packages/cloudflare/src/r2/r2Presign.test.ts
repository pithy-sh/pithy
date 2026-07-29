import { describe, expect, it } from "vitest";
import { CloudflareR2Manager } from "./r2Manager";

/**
 * What a presigned R2 URL actually signs — asserted against the real AWS SDK, not a double.
 *
 * `r2Manager.test.ts` mocks `@aws-sdk/s3-request-presigner` to check *which* command the manager
 * sends, which is the right test for that concern and useless for this one. The claim here is about
 * the SDK's own behaviour: `S3RequestPresigner.prepareRequest` calls
 * `unsignableHeaders.add("content-type")` before signing, so a content type can never be enforced by
 * a presigned URL, while `content-length` can and is.
 *
 * That asymmetry is load-bearing well outside this package. `@pithy-sh/storage` reconciles an
 * object's content type against R2 at completion *because* of it, and neutralises active types on
 * serve on the assumption that a declared type is a client's word and nothing more. If a future SDK
 * release starts signing `content-type`, this test fails first — and the comments and the
 * reconciliation that lean on it get revisited rather than quietly drifting into fiction again.
 *
 * No network: `getSignedUrl` is local crypto over fake credentials.
 */

const manager = new CloudflareR2Manager({
  accountId: "acct-1",
  apiToken: "tok-1",
  bucketName: "bucket-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t-example",
});

/** The `X-Amz-SignedHeaders` list a presigned URL carries, lowercased. */
function signedHeaders(url: string): string[] {
  return (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean);
}

describe("what a presigned R2 upload URL signs", () => {
  it("signs content-length, so a client cannot send more bytes than it was granted", async () => {
    const url = await manager.createUploadUrl("obj/abc", "image/png", 1024);
    expect(signedHeaders(url)).toContain("content-length");
  });

  it("does NOT sign content-type — the presigner marks it unsignable, so the declared type is a hint", async () => {
    const url = await manager.createUploadUrl("obj/abc", "image/png", 1024);
    expect(signedHeaders(url)).not.toContain("content-type");
    // And it is not hoisted into the query string either, so nothing about it reaches R2 from us.
    expect(new URL(url).searchParams.has("Content-Type")).toBe(false);
  });
});
