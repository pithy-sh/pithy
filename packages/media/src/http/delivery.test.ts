// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { IMAGE_REQUESTS, STREAM_MINUTES } from "@pithy-sh/cloudflare/src/analytics/datasets";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import type { ControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { DeliveryDeps, DeliverySource } from "../analytics/delivery";
import { MediaConfig } from "../config/config";
import { extendMediaAsset } from "../data/extend";
import type { MediaRecord } from "../record/store";
import type { HandlerDeps } from "./handlers";
import { MediaDeliveryResponse } from "./responses";
import { registerMediaRoutes } from "./routes";
import { MEDIA_DELIVERY_READ_SCOPE } from "./scopes";

const now = new Date("2026-10-17T12:00:00.000Z");
const LIMITS = { enabled: true, maxDuration: 2_764_800, notOlderThan: 7_948_800, maxPageSize: 10_000 };
const IMAGE_LIMITS = { enabled: true, maxDuration: 2_595_600, notOlderThan: 2_595_600, maxPageSize: 10_000 };

const video = {
  id: "v1",
  type: "video",
  status: "stored",
  name: "Launch",
  filename: "launch.mp4",
  contentType: "video/mp4",
  storageBackend: "cf-stream",
  storageKey: "uid-1",
  hasTranscription: false,
  hasExtractedText: false,
  createdAt: now,
  updatedAt: now,
} as MediaRecord;

function context(granted: string[]): ControlPlaneContext {
  return {
    connectionId: "conn-1",
    environment: "prod",
    issuer: "https://dashboard.example",
    subject: "operator-1",
    scope: MEDIA_DELIVERY_READ_SCOPE,
    grantedScopes: granted,
    keyId: "key-1",
    tokenId: "jti-1",
    actorKind: "dashboard",
  };
}

function harness(granted: string[] = [MEDIA_DELIVERY_READ_SCOPE], source: Partial<DeliverySource> = {}) {
  const events: AuditEventInput[] = [];
  const from: DeliverySource = {
    datasetLimits: vi.fn(async () => ({ [STREAM_MINUTES]: LIMITS, [IMAGE_REQUESTS]: IMAGE_LIMITS })),
    streamMinutesViewed: vi.fn(async () => new Map([["uid-1", 61]])),
    imageRequests: vi.fn(async () => new Map<string, number>()),
    ...source,
  };
  const verify: ControlPlaneVerifier = async (_request, requirement) => {
    if (typeof requirement === "string" && !granted.includes(requirement)) throw new Error(`ungranted ${requirement}`);
    return context(granted);
  };
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", verify);
    c.set("emit", async (event: AuditEventInput) => {
      events.push(event);
    });
    c.set("log", noopLogger);
    await next();
  });
  const config = MediaConfig.parse({});
  const deliveryDeps: DeliveryDeps = {
    assets: async (type) =>
      type === "video" ? [{ id: video.id, name: video.name, storageKey: video.storageKey }] : [],
    config,
    source: async () => from,
    now: () => now,
  };
  registerMediaRoutes({
    config,
    schema: extendMediaAsset(),
    resolveDeps: async () => ({}) as unknown as HandlerDeps,
    resolveDelivery: async () => deliveryDeps,
  })(app);
  return { app, events, from };
}

describe("GET /media/admin/delivery (#728)", () => {
  test("answers per-asset delivery for the default window, in the declared shape", async () => {
    const h = harness();
    const response = await h.app.request("/media/admin/delivery");
    expect(response.status).toBe(200);
    const body = MediaDeliveryResponse.parse(await response.json());
    expect(body.since).toBe("2026-09-17T12:00:00.000Z");
    expect(body.until).toBe(now.toISOString());
    expect(body.video).toEqual({
      state: "reported",
      assets: [{ id: "v1", name: "Launch", storageKey: "uid-1", minutesViewed: 61 }],
    });
    expect(body.images).toEqual({ state: "reported", assets: [] });
  });

  test("since and until set the window", async () => {
    const h = harness();
    const response = await h.app.request(
      "/media/admin/delivery?since=2026-10-01T00:00:00.000Z&until=2026-10-08T00:00:00.000Z",
    );
    expect(response.status).toBe(200);
    expect(h.from.streamMinutesViewed).toHaveBeenCalledWith({
      since: new Date("2026-10-01T00:00:00.000Z"),
      until: new Date("2026-10-08T00:00:00.000Z"),
      uids: ["uid-1"],
    });
  });

  test("a window past retention is a named 400", async () => {
    const response = await harness().app.request("/media/admin/delivery?since=2026-01-01T00:00:00.000Z");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("media/analytics_window");
  });

  test("a malformed bound is a validation failure, never a default window", async () => {
    const response = await harness().app.request("/media/admin/delivery?since=yesterday");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("validation/invalid_input");
  });

  test("a metadata boundary that carries no dataset is a named 409, not an empty answer", async () => {
    const h = harness([MEDIA_DELIVERY_READ_SCOPE], {
      datasetLimits: vi.fn(async () => ({
        [STREAM_MINUTES]: { ...LIMITS, enabled: false },
        [IMAGE_REQUESTS]: IMAGE_LIMITS,
      })),
    });
    const response = await h.app.request("/media/admin/delivery");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("media/analytics_unavailable");
  });

  test("a caller without the scope is refused before anything is read", async () => {
    const h = harness([]);
    const response = await h.app.request("/media/admin/delivery");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(h.from.datasetLimits).not.toHaveBeenCalled();
  });

  test("the read is audited with counts, and never a name or a number of minutes", async () => {
    const h = harness();
    await h.app.request("/media/admin/delivery");
    const event = h.events.find((e) => e.action === "media/delivery_read");
    expect(event).toMatchObject({ outcome: "success", actorType: "control-plane", actorId: "operator-1" });
    expect(event?.metadata).toMatchObject({ videos: 1, images: 0 });
    expect(JSON.stringify(event?.metadata)).not.toContain("Launch");
    expect(JSON.stringify(event?.metadata)).not.toContain("61");
  });
});
