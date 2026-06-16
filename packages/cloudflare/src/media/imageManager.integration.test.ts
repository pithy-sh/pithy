import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, withThrowawayResource } from "../test-utils/harness";
import { CloudflareImageManager } from "./imageManager";

/**
 * LIVE integration test — Cloudflare Images over REST. Uploads a real (1×1 PNG) image, exercises
 * details/update/direct-upload/list against it, then deletes it.
 *
 * Uploading consumes paid Images quota: an account with Images merely *enabled* but no plan has a
 * service limit of 0 and 403s every upload. So this is gated behind `PITHY_IMAGES_PAID=1` (in
 * addition to creds) — set it only on an account with Images quota. Skipped by default. See
 * `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();
const enabled = creds.hasCreds && Boolean(process.env.PITHY_IMAGES_PAID);

// A minimal valid 1×1 transparent PNG — the smallest real image the upload endpoint accepts.
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe.skipIf(!enabled)("CloudflareImageManager — LIVE", () => {
  const images = new CloudflareImageManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("uploads an image, reads + updates + lists it, then deletes it", async () => {
    await withThrowawayResource(
      () =>
        images.uploadImage({
          file: new File([PNG_1X1], "pixel.png", { type: "image/png" }),
          metadata: { tag: "pithy-int" },
        }),
      async (image) => {
        const id = image.id ?? "";
        expect(id).toBeTruthy();
        expect(await images.validateServiceAccess()).toBe(true);

        // Details decode and round-trip the id; variants are part of the decoded shape.
        const details = await images.imageDetails(id);
        expect(details.id).toBe(id);
        expect(Array.isArray(details.variants)).toBe(true);

        // Update a setting and see it reflected.
        expect((await images.updateImage(id, { requireSignedURLs: true })).requireSignedURLs).toBe(true);

        // Direct-upload URL (V2) and a list both decode.
        expect((await images.createDirectUploadUrl({})).uploadURL).toMatch(/^https:\/\//);
        expect(Array.isArray(await images.listImages())).toBe(true);

        // Error path: an unknown image id is a wrapped request failure.
        await expect(images.imageDetails("nonexistent-image-id")).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
        );
      },
      (image) => images.deleteImage(image.id ?? ""),
    );
  });
});
