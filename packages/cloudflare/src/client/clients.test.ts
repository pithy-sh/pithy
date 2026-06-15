import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareD1Manager } from "../d1/d1Manager";
import { CloudflareKVManager } from "../kv/kvManager";
import { CloudflareR2Manager } from "../media/r2Manager";
import { CloudflareClients } from "./clients";

// The aggregator only constructs managers; it makes no SDK calls itself. A bare SDK stub is enough.
vi.mock("cloudflare", () => ({ Cloudflare: class {} }));

describe("CloudflareClients", () => {
  let clients: CloudflareClients;

  beforeEach(() => {
    clients = new CloudflareClients({ apiToken: "tok-1", accountId: "acct-1" });
  });

  describe("resource-scoped managers (keyed by id)", () => {
    it("returns the right manager type configured for the id", () => {
      const kv = clients.kv("ns-1");
      expect(kv).toBeInstanceOf(CloudflareKVManager);
      expect(kv.getKVInfo()).toEqual({ namespaceId: "ns-1", accountId: "acct-1" });

      const d1 = clients.d1("db-1");
      expect(d1).toBeInstanceOf(CloudflareD1Manager);
      expect(d1.getD1Info()).toEqual({ databaseId: "db-1", accountId: "acct-1" });
    });

    it("memoizes one instance per id and a fresh one for a new id", () => {
      expect(clients.kv("ns-1")).toBe(clients.kv("ns-1"));
      expect(clients.kv("ns-1")).not.toBe(clients.kv("ns-2"));
      expect(clients.d1("db-1")).toBe(clients.d1("db-1"));
    });
  });

  describe("account-scoped managers (singletons)", () => {
    it("returns one shared instance across calls", () => {
      expect(clients.ai()).toBe(clients.ai());
      expect(clients.images()).toBe(clients.images());
      expect(clients.stream()).toBe(clients.stream());
      expect(clients.workers()).toBe(clients.workers());
      expect(clients.builds()).toBe(clients.builds());
      expect(clients.turnstile()).toBe(clients.turnstile());
      expect(clients.provisioner()).toBe(clients.provisioner());
    });
  });

  describe("r2 (needs S3 credentials)", () => {
    it("constructs a fresh manager each call so rotated credentials are never stale", () => {
      const a = clients.r2({ accessKeyId: "ak1", secretAccessKey: "sk1", bucketName: "assets" });
      const b = clients.r2({ accessKeyId: "ak2", secretAccessKey: "sk2", bucketName: "assets" });
      expect(b).not.toBe(a);
      expect(a).toBeInstanceOf(CloudflareR2Manager);
    });
  });
});
