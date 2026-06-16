import { describe, expect, test } from "vitest";
import { loadIntegrationCreds, withThrowawayResource } from "../test-utils/harness";
import { CloudflareStreamManager } from "./streamManager";

/**
 * LIVE integration test — Cloudflare Stream over REST. A direct-upload reservation creates a real
 * video resource (a `uid`) without uploading any video bytes, so the create→read→delete lifecycle is
 * exercised cheaply.
 *
 * Even a reservation counts against paid Stream minutes: an account with Stream merely *enabled* but
 * no allocated minutes 413s the reservation. So this is gated behind `PITHY_STREAM_PAID=1` (in
 * addition to creds) — set it only on an account with Stream minutes. Skipped by default. See
 * `kvManager.integration.test.ts` for the template.
 */
const creds = loadIntegrationCreds();
const enabled = creds.hasCreds && Boolean(process.env.PITHY_STREAM_PAID);

describe.skipIf(!enabled)("CloudflareStreamManager — LIVE", () => {
  const stream = new CloudflareStreamManager({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("reserves a direct-upload video, reads its details, then deletes it", async () => {
    await withThrowawayResource(
      () => stream.createDirectUpload({ maxDurationSeconds: 60 }),
      async (upload) => {
        const uid = upload.uid ?? "";
        expect(uid).toBeTruthy();
        expect(await stream.validateServiceAccess()).toBe(true);

        // Details decode and round-trip the uid.
        expect((await stream.getVideoDetails(uid)).uid).toBe(uid);

        // Error path: an unknown video id is a wrapped request failure.
        await expect(stream.getVideoDetails("nonexistent-video-uid")).rejects.toThrowError(
          expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
        );
      },
      async (upload) => {
        if (upload.uid) await stream.deleteVideo(upload.uid);
      },
    );
  });
});
