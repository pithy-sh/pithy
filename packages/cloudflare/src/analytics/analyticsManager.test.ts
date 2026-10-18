// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_KEY_CHUNK, CloudflareAnalyticsManager, IMAGE_REQUESTS, STREAM_MINUTES } from "./analyticsManager";

/** The SDK's raw `post`, which every query goes through. Answers what the GraphQL endpoint answers. */
const mockPost = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    post = mockPost;
  },
}));

const since = new Date("2026-09-17T00:00:00.000Z");
const until = new Date("2026-10-17T00:00:00.000Z");

/** The body the manager sent on the n-th call: `{ query, variables }`. */
function sent(call = 0): { query: string; variables: Record<string, unknown> } {
  const [path, options] = mockPost.mock.calls[call] as [
    string,
    { body: { query: string; variables: Record<string, unknown> } },
  ];
  expect(path).toBe("/graphql");
  return options.body;
}

/** One account's answer, the shape `viewer.accounts[0]` takes. */
function answer(account: Record<string, unknown>): unknown {
  return { data: { viewer: { accounts: [account] } }, errors: null };
}

describe("CloudflareAnalyticsManager", () => {
  let manager: CloudflareAnalyticsManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareAnalyticsManager({ accountId: "acct-1", apiToken: "tok-1" });
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Analytics");
  });

  describe("datasetLimits", () => {
    it("reads each dataset's retention and range from the account's own settings, in seconds", async () => {
      // Measured against a live account, 2026-10-17: Stream keeps 92 days and serves 32 at a time; hosted
      // Images keeps and serves 30 days and one hour. The kit reads these rather than assuming them.
      mockPost.mockResolvedValueOnce(
        answer({
          settings: {
            [STREAM_MINUTES]: { enabled: true, maxDuration: 2764800, notOlderThan: 7948800, maxPageSize: 10000 },
            [IMAGE_REQUESTS]: { enabled: false, maxDuration: 2595600, notOlderThan: 2595600, maxPageSize: 10000 },
          },
        }),
      );
      const limits = await manager.datasetLimits([STREAM_MINUTES, IMAGE_REQUESTS]);
      expect(limits[STREAM_MINUTES]).toEqual({
        enabled: true,
        maxDuration: 2764800,
        notOlderThan: 7948800,
        maxPageSize: 10000,
      });
      expect(limits[IMAGE_REQUESTS]?.enabled).toBe(false);
      expect(sent().variables).toEqual({ account: "acct-1" });
      expect(sent().query).toContain(`${STREAM_MINUTES} {`);
      expect(sent().query).toContain(`${IMAGE_REQUESTS} {`);
    });

    it("reads a null or missing dataset as absent, so the caller can name it, rather than refusing the answer", async () => {
      // Under a Customer Metadata Boundary outside the US, Cloudflare serves neither dataset. Its settings
      // node answers null for one it does not serve, or leaves the key out.
      mockPost.mockResolvedValueOnce(answer({ settings: { [STREAM_MINUTES]: null } }));
      const limits = await manager.datasetLimits([STREAM_MINUTES, IMAGE_REQUESTS]);
      expect(limits[STREAM_MINUTES]).toBeUndefined();
      expect(limits[IMAGE_REQUESTS]).toBeUndefined();
      expect(STREAM_MINUTES in limits).toBe(false);
    });

    it("refuses an account the token cannot see, rather than reading it as a dataset with no limits", async () => {
      mockPost.mockResolvedValueOnce({ data: { viewer: { accounts: [] } }, errors: null });
      await expect(manager.datasetLimits([STREAM_MINUTES])).rejects.toThrow(PithyError);
    });
  });

  describe("streamMinutesViewed", () => {
    it("sums minutes per uid inside the window, filtered to the uids asked about", async () => {
      mockPost.mockResolvedValueOnce(
        answer({
          [STREAM_MINUTES]: [
            { sum: { minutesViewed: 12 }, dimensions: { uid: "v1" } },
            { sum: { minutesViewed: 3 }, dimensions: { uid: "v2" } },
          ],
        }),
      );
      const minutes = await manager.streamMinutesViewed({ since, until, uids: ["v1", "v2", "v3"] });
      expect(minutes).toEqual(
        new Map([
          ["v1", 12],
          ["v2", 3],
        ]),
      );
      expect(sent().variables).toEqual({
        account: "acct-1",
        filter: { datetime_geq: since.toISOString(), datetime_lt: until.toISOString(), uid_in: ["v1", "v2", "v3"] },
        limit: 3,
      });
      expect(sent().query).toContain("minutesViewed");
      expect(sent().query).toContain("uid");
    });

    it("asks nothing for no uids", async () => {
      expect(await manager.streamMinutesViewed({ since, until, uids: [] })).toEqual(new Map());
      expect(mockPost).not.toHaveBeenCalled();
    });

    it("asks in bounded chunks, so a large library is never one unbounded filter", async () => {
      const uids = Array.from({ length: ANALYTICS_KEY_CHUNK + 1 }, (_, i) => `v${i}`);
      mockPost
        .mockResolvedValueOnce(answer({ [STREAM_MINUTES]: [{ sum: { minutesViewed: 1 }, dimensions: { uid: "v0" } }] }))
        .mockResolvedValueOnce(
          answer({ [STREAM_MINUTES]: [{ sum: { minutesViewed: 2 }, dimensions: { uid: `v${ANALYTICS_KEY_CHUNK}` } }] }),
        );
      const minutes = await manager.streamMinutesViewed({ since, until, uids });
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect((sent(0).variables.filter as { uid_in: string[] }).uid_in).toHaveLength(ANALYTICS_KEY_CHUNK);
      expect((sent(1).variables.filter as { uid_in: string[] }).uid_in).toEqual([`v${ANALYTICS_KEY_CHUNK}`]);
      expect(minutes.get("v0")).toBe(1);
      expect(minutes.get(`v${ANALYTICS_KEY_CHUNK}`)).toBe(2);
    });

    it("refuses with Cloudflare's own words when the query answers errors", async () => {
      mockPost.mockResolvedValueOnce({
        data: null,
        errors: [{ message: "not authorized for that account", extensions: { code: "authz" } }],
      });
      const failure = await manager.streamMinutesViewed({ since, until, uids: ["v1"] }).catch((error) => error);
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.code).toBe("cloudflare/request_failed");
      expect((failure as PithyError).payload.message).toContain("not authorized for that account");
    });

    it("a spent rate budget is an upstream failure a caller may retry, not a request that is wrong", async () => {
      // Measured 2026-10-17: the endpoint answers 200 with `extensions.code: "budget"` and asks for five
      // minutes. The same query succeeds once the budget refills, so it must read as retryable.
      mockPost.mockResolvedValueOnce({
        data: null,
        errors: [
          {
            message: "Rate limiter budget depleted. Please try again after 5 minutes.",
            extensions: { code: "budget" },
          },
        ],
      });
      const failure = await manager.streamMinutesViewed({ since, until, uids: ["v1"] }).catch((error) => error);
      expect((failure as PithyError).payload.code).toBe("core/upstream_failed");
    });

    it("refuses a response of the wrong shape rather than reading it as zero minutes", async () => {
      mockPost.mockResolvedValueOnce(answer({ [STREAM_MINUTES]: [{ sum: {}, dimensions: { uid: "v1" } }] }));
      const failure = await manager.streamMinutesViewed({ since, until, uids: ["v1"] }).catch((error) => error);
      expect((failure as PithyError).payload.code).toBe("cloudflare/invalid_response");
    });
  });

  describe("imageRequests", () => {
    it("counts delivery requests per image id inside the window", async () => {
      mockPost.mockResolvedValueOnce(
        answer({
          [IMAGE_REQUESTS]: [
            { count: 40, dimensions: { imageId: "i1" } },
            { count: 2, dimensions: { imageId: "i2" } },
          ],
        }),
      );
      const requests = await manager.imageRequests({ since, until, imageIds: ["i1", "i2"] });
      expect(requests).toEqual(
        new Map([
          ["i1", 40],
          ["i2", 2],
        ]),
      );
      expect(sent().variables).toEqual({
        account: "acct-1",
        filter: { datetime_geq: since.toISOString(), datetime_lt: until.toISOString(), imageId_in: ["i1", "i2"] },
        limit: 2,
      });
      expect(sent().query).toContain("imageId");
    });
  });
});
