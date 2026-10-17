// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { DeliverySigner } from "../deliver/sign";
import { MediaEnrichmentError } from "../error/errors";
import { ENRICHMENT_URL_TTL_MS, enrichmentImageUrl, enrichmentPlaylistUrl } from "./sources";

/**
 * The enrichment worker reads a private record's bytes the same way a reader does: through a signed URL.
 * A plain URL to a signed asset answers nobody, so a private image or video would enrich nothing.
 */

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const HLS = "https://customer-abc.cloudflarestream.com/vid-1/manifest/video.m3u8";

/** A signer that records what it was asked and stamps its output so the test can see it was used. */
function fakeSigner() {
  const calls: { kind: "image" | "stream"; subject: string; expiresAt: Date }[] = [];
  const signer: DeliverySigner = {
    async signImageUrl(url, expiresAt) {
      calls.push({ kind: "image", subject: url, expiresAt });
      return `${url}?sig=signed`;
    },
    async streamToken(uid, expiresAt) {
      calls.push({ kind: "stream", subject: uid, expiresAt });
      return "TOKEN";
    },
  };
  let resolved = 0;
  const lazy = async () => {
    resolved++;
    return signer;
  };
  return { calls, lazy, resolved: () => resolved };
}

describe("enrichmentImageUrl", () => {
  test("a public image reads from its plain delivery URL, and no signer is resolved", async () => {
    const signer = fakeSigner();
    const url = await enrichmentImageUrl({ storageKey: "img-1", signedDelivery: false }, "hash", signer.lazy, NOW);
    expect(url).toBe("https://imagedelivery.net/hash/img-1/public");
    expect(signer.resolved()).toBe(0);
  });

  test("a signed image reads from a URL signed to expire one TTL from now", async () => {
    const signer = fakeSigner();
    const url = await enrichmentImageUrl({ storageKey: "img-1", signedDelivery: true }, "hash", signer.lazy, NOW);
    expect(url).toBe("https://imagedelivery.net/hash/img-1/public?sig=signed");
    expect(signer.calls).toEqual([
      {
        kind: "image",
        subject: "https://imagedelivery.net/hash/img-1/public",
        expiresAt: new Date(NOW + ENRICHMENT_URL_TTL_MS),
      },
    ]);
  });

  test("refuses without an Images account hash", async () => {
    const signer = fakeSigner();
    await expect(
      enrichmentImageUrl({ storageKey: "img-1", signedDelivery: true }, undefined, signer.lazy, NOW),
    ).rejects.toBeInstanceOf(MediaEnrichmentError);
  });
});

describe("enrichmentPlaylistUrl", () => {
  test("a public video plays from Stream's own HLS URL, and no signer is resolved", async () => {
    const signer = fakeSigner();
    expect(await enrichmentPlaylistUrl({ storageKey: "vid-1", signedDelivery: false }, HLS, signer.lazy, NOW)).toBe(
      HLS,
    );
    expect(signer.resolved()).toBe(0);
  });

  test("a signed video plays with a token in the uid's place", async () => {
    const signer = fakeSigner();
    const url = await enrichmentPlaylistUrl({ storageKey: "vid-1", signedDelivery: true }, HLS, signer.lazy, NOW);
    expect(url).toBe("https://customer-abc.cloudflarestream.com/TOKEN/manifest/video.m3u8");
    expect(signer.calls).toEqual([
      { kind: "stream", subject: "vid-1", expiresAt: new Date(NOW + ENRICHMENT_URL_TTL_MS) },
    ]);
  });

  test("refuses a playback URL that does not carry the uid, rather than fetching it unsigned", async () => {
    const signer = fakeSigner();
    await expect(
      enrichmentPlaylistUrl(
        { storageKey: "vid-1", signedDelivery: true },
        "https://customer-abc.cloudflarestream.com/other/manifest/video.m3u8",
        signer.lazy,
        NOW,
      ),
    ).rejects.toBeInstanceOf(MediaEnrichmentError);
  });
});
