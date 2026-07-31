// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareEmailRoutingManager } from "./emailRoutingManager";

const mockRulesCreate = vi.fn();
const mockRulesDelete = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    emailRouting = { rules: { create: mockRulesCreate, delete: mockRulesDelete } };
  },
}));

/** The raw list envelope the idempotency read parses (that read has no SDK method — see the manager). */
function listResponse(names: string[], ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => ({ success: true, result: names.map((name, i) => ({ id: `rule-${i}`, name })) }),
    text: async () => "forbidden",
  };
}

/**
 * A paged list response: page `page` of `pages`, each full except the last.
 *
 * The manager must walk every page, because both callers read "not in the list" as "does not exist"
 * — so a truncated read is not a smaller answer, it is the wrong one.
 */
function pagedResponse(pages: string[][], page: number) {
  const names = pages[page - 1] ?? [];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      result: names.map((name, i) => ({ id: `rule-${page}-${i}`, name })),
      result_info: { page, per_page: 50, total_count: pages.flat().length, total_pages: pages.length },
    }),
    text: async () => "",
  };
}

/** Serve `pages` in order, one per call, so a fetch mock behaves like a real paged endpoint. */
function pagedFetch(pages: string[][]) {
  return vi.fn().mockImplementation((url: string) => {
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return Promise.resolve(pagedResponse(pages, page));
  });
}

const route = {
  zoneId: "zone-9",
  address: "bounces@pithy.sh",
  workerName: "pithy-email",
  ruleName: "pithy-bounces",
};

describe("CloudflareEmailRoutingManager", () => {
  let manager: CloudflareEmailRoutingManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    manager = new CloudflareEmailRoutingManager({ accountId: "acct-1", apiToken: "tok-1" });
  });

  it("reports its service type", () => {
    expect(manager.getServiceType()).toBe("Email Routing");
  });

  describe("ensureWorkerRoute", () => {
    it("creates the rule through the SDK when no rule of that name exists", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse(["some-other-rule"])));
      mockRulesCreate.mockResolvedValue({ id: "rule-new" });

      expect(await manager.ensureWorkerRoute(route)).toEqual({ created: true });
      expect(mockRulesCreate).toHaveBeenCalledWith({
        zone_id: "zone-9",
        name: "pithy-bounces",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "bounces@pithy.sh" }],
        actions: [{ type: "worker", value: ["pithy-email"] }],
      });
    });

    // Idempotency is the contract: provisioning re-runs, and a second create would duplicate the rule.
    it("is a no-op when a rule of that name already exists", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse(["pithy-bounces"])));

      expect(await manager.ensureWorkerRoute(route)).toEqual({ created: false });
      expect(mockRulesCreate).not.toHaveBeenCalled();
    });

    it("reads the rule list from the zone, not the account", async () => {
      const fetchMock = vi.fn().mockResolvedValue(listResponse([]));
      vi.stubGlobal("fetch", fetchMock);
      mockRulesCreate.mockResolvedValue({ id: "rule-new" });

      await manager.ensureWorkerRoute(route);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/zones/zone-9/email/routing/rules?page=1&per_page=50",
        { headers: { Authorization: "Bearer tok-1" } },
      );
    });

    // A failed listing must not be read as "no such rule" — that would create a duplicate on every run.
    it("throws rather than creating when the rule list cannot be read", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse([], false, 403)));

      await expect(manager.ensureWorkerRoute(route)).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
      expect(mockRulesCreate).not.toHaveBeenCalled();
    });

    it("wraps an SDK create failure as cloudflare/request_failed", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse([])));
      mockRulesCreate.mockRejectedValue(new Error("routing not enabled"));

      await expect(manager.ensureWorkerRoute(route)).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "routing not enabled" }),
        }),
      );
    });
  });

  describe("removeWorkerRoute", () => {
    it("deletes the rule of that name, by the id the listing carries", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse(["some-other-rule", "pithy-bounces"])));

      expect(await manager.removeWorkerRoute({ zoneId: "zone-9", ruleName: "pithy-bounces" })).toEqual({
        removed: true,
      });
      expect(mockRulesDelete).toHaveBeenCalledWith("rule-1", { zone_id: "zone-9" });
    });

    // Teardown re-runs, and the second pass finds nothing. That has to be a no-op, not a failure.
    it("is a no-op when the zone carries no rule of that name", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse(["some-other-rule"])));

      expect(await manager.removeWorkerRoute({ zoneId: "zone-9", ruleName: "pithy-bounces" })).toEqual({
        removed: false,
      });
      expect(mockRulesDelete).not.toHaveBeenCalled();
    });

    // A failed listing read as "already gone" would report mail stopped while it is still being delivered.
    it("throws rather than reporting removal when the rule list cannot be read", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(listResponse([], false, 403)));

      await expect(manager.removeWorkerRoute({ zoneId: "zone-9", ruleName: "pithy-bounces" })).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
      expect(mockRulesDelete).not.toHaveBeenCalled();
    });
  });

  describe("rule listing pages to exhaustion", () => {
    it("finds a rule that lives on the second page, so provisioning does not duplicate it", async () => {
      // The failure this prevents: an unseen rule reads as absent, and `ensureWorkerRoute` then
      // creates a second rule for the same address on every single run.
      const fetchMock = pagedFetch([Array.from({ length: 50 }, (_, i) => `filler-${i}`), ["pithy-bounces"]]);
      vi.stubGlobal("fetch", fetchMock);

      await expect(manager.ensureWorkerRoute(route)).resolves.toEqual({ created: false });
      expect(mockRulesCreate).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("deletes a rule that lives on the second page, rather than reporting nothing to remove", async () => {
      // The mirror failure: a teardown that says mail stopped while it is still being delivered.
      vi.stubGlobal("fetch", pagedFetch([Array.from({ length: 50 }, (_, i) => `filler-${i}`), ["pithy-bounces"]]));

      await expect(manager.removeWorkerRoute({ zoneId: route.zoneId, ruleName: route.ruleName })).resolves.toEqual({
        removed: true,
      });
      expect(mockRulesDelete).toHaveBeenCalledWith("rule-2-0", { zone_id: "zone-9" });
    });

    it("stops after the last page rather than requesting one that does not exist", async () => {
      const fetchMock = pagedFetch([["only-rule"]]);
      vi.stubGlobal("fetch", fetchMock);

      await manager.removeWorkerRoute({ zoneId: route.zoneId, ruleName: "absent" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("terminates on a short page when the response carries no paging block at all", async () => {
      // An older or proxied response omits `result_info`; the loop must still end.
      const fetchMock = vi.fn().mockResolvedValue(listResponse(["only-rule"]));
      vi.stubGlobal("fetch", fetchMock);

      await expect(manager.removeWorkerRoute({ zoneId: route.zoneId, ruleName: "absent" })).resolves.toEqual({
        removed: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
