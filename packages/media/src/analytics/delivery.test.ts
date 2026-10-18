// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { IMAGE_REQUESTS, STREAM_MINUTES } from "@pithy-sh/cloudflare/src/analytics/datasets";
import { DEFAULT_WINDOW_DAYS } from "@pithy-sh/cloudflare/src/analytics/window";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { MediaConfig, type MediaConfigInput } from "../config/config";
import type { MediaType, StorageBackend } from "../data/enums";
import type { MediaRecord } from "../record/store";
import type { StoredAssetReader } from "./assets";
import { type DeliverySource, readDelivery, resolveWindow } from "./delivery";

const DAY = 86_400_000;
const now = new Date("2026-10-17T12:00:00.000Z");

function record(id: string, type: MediaType, storageBackend: StorageBackend, extra: Partial<MediaRecord> = {}) {
  return {
    id,
    type,
    status: "stored",
    name: `${id} name`,
    filename: `${id}.bin`,
    contentType: "application/octet-stream",
    size: 1,
    storageBackend,
    storageKey: `key-${id}`,
    hasTranscription: false,
    hasExtractedText: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  } as MediaRecord;
}

/** The environment's asset reader over an array — stored rows of one type on one backend, as the query answers. */
function arrayAssets(records: MediaRecord[]): StoredAssetReader {
  return async (type, backend) =>
    records
      .filter((r) => r.type === type && r.status === "stored" && r.storageBackend === backend)
      .map((r) => ({ id: r.id, name: r.name, storageKey: r.storageKey }));
}

const LIMITS = { enabled: true, maxDuration: 2_764_800, notOlderThan: 7_948_800, maxPageSize: 10_000 };
const IMAGE_LIMITS = { enabled: true, maxDuration: 2_595_600, notOlderThan: 2_595_600, maxPageSize: 10_000 };

function source(overrides: Partial<DeliverySource> = {}): DeliverySource {
  return {
    datasetLimits: vi.fn(async () => ({ [STREAM_MINUTES]: LIMITS, [IMAGE_REQUESTS]: IMAGE_LIMITS })),
    streamMinutesViewed: vi.fn(async () => new Map<string, number>()),
    imageRequests: vi.fn(async () => new Map<string, number>()),
    ...overrides,
  };
}

function deps(records: MediaRecord[], from: DeliverySource, config: MediaConfigInput = {}) {
  return {
    assets: arrayAssets(records),
    config: MediaConfig.parse(config),
    source: vi.fn(async () => from),
    now: () => now,
  };
}

describe("resolveWindow", () => {
  test("defaults to the last 30 days, ending now", () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
    expect(resolveWindow({}, now)).toEqual({ since: new Date(now.getTime() - 30 * DAY), until: now });
  });

  test("a since alone runs to now, and an until alone reaches back 30 days", () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    expect(resolveWindow({ since }, now)).toEqual({ since, until: now });
    const until = new Date("2026-10-10T00:00:00.000Z");
    expect(resolveWindow({ until }, now)).toEqual({ since: new Date(until.getTime() - 30 * DAY), until });
  });

  test("a window that ends before it starts is refused", () => {
    const failure = (() => {
      try {
        resolveWindow({ since: now, until: new Date(now.getTime() - DAY) }, now);
      } catch (error) {
        return error as PithyError;
      }
    })();
    expect(failure?.payload.code).toBe("media/analytics_window");
  });
});

describe("readDelivery (#728)", () => {
  test("minutes delivered resolve per asset, joining the Stream uid to storageKey", async () => {
    const from = source({
      streamMinutesViewed: vi.fn(async () => new Map([["key-v1", 42]])),
    });
    const report = await readDelivery(
      deps([record("v1", "video", "cf-stream"), record("v2", "video", "cf-stream")], from),
      {},
    );
    expect(report.video).toEqual({
      state: "reported",
      assets: [
        { id: "v1", name: "v1 name", storageKey: "key-v1", minutesViewed: 42 },
        { id: "v2", name: "v2 name", storageKey: "key-v2", minutesViewed: 0 },
      ],
    });
    expect(from.streamMinutesViewed).toHaveBeenCalledWith({
      since: new Date(now.getTime() - 30 * DAY),
      until: now,
      uids: ["key-v1", "key-v2"],
    });
  });

  test("images served resolve per asset, joining the Images id to storageKey", async () => {
    const from = source({ imageRequests: vi.fn(async () => new Map([["key-i2", 7]])) });
    const report = await readDelivery(
      deps([record("i1", "image", "cf-images"), record("i2", "image", "cf-images")], from),
      {},
    );
    expect(report.images).toEqual({
      state: "reported",
      assets: [
        { id: "i2", name: "i2 name", storageKey: "key-i2", requests: 7 },
        { id: "i1", name: "i1 name", storageKey: "key-i1", requests: 0 },
      ],
    });
  });

  test("the read asks only about this environment's own assets — never the account's", async () => {
    // The dataset is account-wide; the asset table is this environment's. A uid another environment owns
    // is never asked about, so it can never be reported here.
    const from = source({
      streamMinutesViewed: vi.fn(
        async () =>
          new Map([
            ["key-v1", 5],
            ["someone-elses", 900],
          ]),
      ),
    });
    const report = await readDelivery(
      deps(
        [
          record("v1", "video", "cf-stream"),
          record("pending", "video", "cf-stream", { status: "pending" }),
          record("raw", "video", "r2"),
          record("doc", "document", "r2"),
        ],
        from,
      ),
      {},
    );
    expect(from.streamMinutesViewed).toHaveBeenCalledWith(expect.objectContaining({ uids: ["key-v1"] }));
    expect(report.video.state === "reported" && report.video.assets.map((asset) => asset.id)).toEqual(["v1"]);
  });

  test("a type stored in R2 is named as unavailable and why, never reported as zero", async () => {
    const from = source();
    const report = await readDelivery(deps([], from, { images: { store: "r2" }, video: { store: "r2" } }), {});
    expect(report.images).toMatchObject({ state: "unavailable", reason: "stored-in-r2" });
    expect(report.video).toMatchObject({ state: "unavailable", reason: "stored-in-r2" });
    expect(report.images.state === "unavailable" && report.images.message).toBe(
      "Images are stored in R2 (images.store in pithy.config.ts), so Cloudflare Images counts nothing for them.",
    );
    expect(report.video.state === "unavailable" && report.video.message).toBe(
      "Videos are stored in R2 (video.store in pithy.config.ts), so Cloudflare Stream counts nothing for them.",
    );
    // Nothing to ask Cloudflare, so nothing is asked — not even for the credential.
    expect(from.datasetLimits).not.toHaveBeenCalled();
  });

  test("a dataset Cloudflare does not serve to this account is a named refusal, not an empty result", async () => {
    // A Customer Metadata Boundary outside the US: the settings node answers `enabled: false`.
    const from = source({
      datasetLimits: vi.fn(async () => ({
        [STREAM_MINUTES]: { ...LIMITS, enabled: false },
        [IMAGE_REQUESTS]: IMAGE_LIMITS,
      })),
    });
    const failure = await readDelivery(deps([record("v1", "video", "cf-stream")], from), {}).catch((error) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.code).toBe("media/analytics_unavailable");
    expect((failure as PithyError).payload.message).toMatch(/metadata boundary/i);
    expect(from.streamMinutesViewed).not.toHaveBeenCalled();
  });

  test("a window older than the dataset keeps is refused, naming the cap", async () => {
    const from = source();
    const since = new Date(now.getTime() - 50 * DAY);
    const until = new Date(now.getTime() - 40 * DAY);
    const failure = await readDelivery(deps([], from), { since, until }).catch((error) => error);
    expect((failure as PithyError).payload.code).toBe("media/analytics_window");
    // Stream keeps 92 days, so this window suits it. Hosted Images keeps 30, and the refusal names that one.
    expect((failure as PithyError).payload.message).toMatch(/30 days/);
    expect((failure as PithyError).payload.params).toMatchObject({ maxDays: 30 });
  });

  test("a window wider than one read may ask for is refused, naming the cap", async () => {
    const from = source();
    const failure = await readDelivery(deps([], from, { images: { store: "r2" } }), {
      since: new Date(now.getTime() - 40 * DAY),
    }).catch((error) => error);
    expect((failure as PithyError).payload.code).toBe("media/analytics_window");
    expect((failure as PithyError).payload.message).toMatch(/32 days/);
  });

  test("the default window fits every dataset Cloudflare offers today", async () => {
    // Hosted Images answers at most 30 days and one hour, measured 2026-10-17. The default must fit it.
    await expect(readDelivery(deps([], source()), {})).resolves.toMatchObject({ video: { state: "reported" } });
  });

  test("the report carries the window it answered for", async () => {
    const report = await readDelivery(deps([], source()), {});
    expect(report.since).toBe(new Date(now.getTime() - 30 * DAY).toISOString());
    expect(report.until).toBe(now.toISOString());
  });
});
