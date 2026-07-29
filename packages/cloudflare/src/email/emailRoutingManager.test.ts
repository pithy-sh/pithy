import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareEmailRoutingManager } from "./emailRoutingManager";

const mockRulesCreate = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    emailRouting = { rules: { create: mockRulesCreate } };
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

      expect(fetchMock).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/zones/zone-9/email/routing/rules", {
        headers: { Authorization: "Bearer tok-1" },
      });
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
});
