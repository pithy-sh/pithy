// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareTurnstileManager, TurnstileVerification } from "./turnstileManager";

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();
const mockRotate = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    turnstile = {
      widgets: {
        list: mockList,
        create: mockCreate,
        delete: mockDelete,
        update: mockUpdate,
        rotateSecret: mockRotate,
      },
    };
  },
}));

/** An async iterable over the given widgets, matching the SDK's auto-paginating list. */
function asyncWidgets(widgets: Array<{ name: string; sitekey: string; domains?: string[] }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const widget of widgets) yield widget;
    },
  };
}

describe("CloudflareTurnstileManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  const opts = { timeout: 10000, maxRetries: 3 };
  let manager: CloudflareTurnstileManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareTurnstileManager(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("constructor and config guards", () => {
    it("reports its service type", () => {
      expect(manager.getServiceType()).toBe("Cloudflare Turnstile");
    });

    it("throws cloudflare/not_configured when apiToken is missing", () => {
      expect(() => new CloudflareTurnstileManager({ accountId: "a", apiToken: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws cloudflare/not_configured when accountId is missing", () => {
      expect(() => new CloudflareTurnstileManager({ accountId: "", apiToken: "t" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("TurnstileVerification schema", () => {
    it("round-trips challenge_ts through the JsonDate codec", () => {
      const iso = "2026-06-14T12:00:00.000Z";
      const decoded = TurnstileVerification.parse({
        success: true,
        "error-codes": [],
        challenge_ts: iso,
        hostname: "example.com",
      });
      expect(decoded.challenge_ts).toBeInstanceOf(Date);
      expect(decoded.challenge_ts?.toISOString()).toBe(iso);

      const encoded = TurnstileVerification.encode(decoded);
      expect(encoded.challenge_ts).toBe(iso);
    });

    it("defaults error-codes to an empty array when absent", () => {
      const decoded = TurnstileVerification.parse({ success: true });
      expect(decoded["error-codes"]).toEqual([]);
    });
  });

  describe("verify", () => {
    it("posts to siteverify and returns the validated response", async () => {
      const iso = "2026-06-14T08:30:00.000Z";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, "error-codes": [], challenge_ts: iso, hostname: "pithy.sh" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await manager.verify("token-abc", "secret-xyz", { remoteIp: "1.2.3.4", action: "signup" });

      expect(result.success).toBe(true);
      expect(result.challenge_ts).toBeInstanceOf(Date);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      expect(init.method).toBe("POST");
      const sent = init.body as URLSearchParams;
      expect(sent.get("secret")).toBe("secret-xyz");
      expect(sent.get("response")).toBe("token-abc");
      expect(sent.get("remoteip")).toBe("1.2.3.4");
      expect(sent.get("action")).toBe("signup");
    });

    it("returns a failed verification with error codes", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
        }),
      );

      const result = await manager.verify("bad", "secret");
      expect(result.success).toBe(false);
      expect(result["error-codes"]).toEqual(["invalid-input-response"]);
    });

    it("throws cloudflare/invalid_response on a malformed body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: "shape" }) }));

      await expect(manager.verify("t", "s")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("throws cloudflare/invalid_response on a non-OK status", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }));

      await expect(manager.verify("t", "s")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("wraps a network failure as cloudflare/request_failed with the cause in detail", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

      await expect(manager.verify("t", "s")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "ECONNRESET" }),
        }),
      );
    });
  });

  describe("getTurnstile", () => {
    it("finds a widget by name", async () => {
      mockList.mockReturnValue(
        asyncWidgets([
          { name: "other", sitekey: "key-other" },
          { name: "my-site", sitekey: "key-123" },
        ]),
      );
      const result = await manager.getTurnstile("my-site");
      expect(result).toEqual({ name: "my-site", sitekey: "key-123" });
      expect(mockList).toHaveBeenCalledWith({ account_id: "acct-1" });
    });

    it("returns null when no widget matches", async () => {
      mockList.mockReturnValue(asyncWidgets([{ name: "other", sitekey: "key-other" }]));
      expect(await manager.getTurnstile("missing")).toBeNull();
    });

    it("wraps a list failure as cloudflare/request_failed", async () => {
      mockList.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("API error")),
        }),
      });
      await expect(manager.getTurnstile("my-site")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("listTurnstilesByDomain", () => {
    it("returns every widget claiming the domain — a domain is not unique across widgets", async () => {
      mockList.mockReturnValue(
        asyncWidgets([
          { name: "elsewhere", sitekey: "key-1", domains: ["other.example.com"] },
          { name: "mine", sitekey: "key-2", domains: ["app.example.com", "www.example.com"] },
          { name: "theirs", sitekey: "key-3", domains: ["app.example.com"] },
        ]),
      );
      expect((await manager.listTurnstilesByDomain("app.example.com")).map((w) => w.name)).toEqual(["mine", "theirs"]);
    });

    it("matches case-insensitively, hostnames being case-insensitive", async () => {
      mockList.mockReturnValue(asyncWidgets([{ name: "mine", sitekey: "key-1", domains: ["App.Example.COM"] }]));
      expect((await manager.listTurnstilesByDomain("app.example.com")).map((w) => w.name)).toEqual(["mine"]);
    });

    it("returns an empty list when no widget claims the domain", async () => {
      mockList.mockReturnValue(asyncWidgets([{ name: "elsewhere", sitekey: "key-1", domains: ["other.example.com"] }]));
      expect(await manager.listTurnstilesByDomain("app.example.com")).toEqual([]);
    });

    it("wraps a list failure as cloudflare/request_failed", async () => {
      mockList.mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("API error")) }),
      });
      await expect(manager.listTurnstilesByDomain("app.example.com")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("addTurnstile", () => {
    it("creates a widget in invisible mode by default", async () => {
      const widget = { sitekey: "key-new", name: "my-site", mode: "invisible" };
      mockCreate.mockResolvedValue(widget);

      const result = await manager.addTurnstile("my-site", ["example.com"]);

      expect(result).toEqual(widget);
      expect(mockCreate).toHaveBeenCalledWith(
        { account_id: "acct-1", domains: ["example.com"], mode: "invisible", name: "my-site" },
        opts,
      );
    });

    it("creates a managed (visible) widget when asked", async () => {
      const widget = { sitekey: "key-vis", name: "my-login", mode: "managed" };
      mockCreate.mockResolvedValue(widget);

      const result = await manager.addTurnstile("my-login", ["example.com"], "managed");

      expect(result).toEqual(widget);
      expect(mockCreate).toHaveBeenCalledWith(
        { account_id: "acct-1", domains: ["example.com"], mode: "managed", name: "my-login" },
        opts,
      );
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause in detail", async () => {
      mockCreate.mockRejectedValue(new Error("Limit reached"));
      await expect(manager.addTurnstile("site", ["d.com"])).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "Limit reached" }),
        }),
      );
    });
  });

  describe("deleteTurnstile", () => {
    it("deletes a widget by sitekey", async () => {
      mockDelete.mockResolvedValue(undefined);
      await manager.deleteTurnstile("key-123");
      expect(mockDelete).toHaveBeenCalledWith("key-123", { account_id: "acct-1" }, opts);
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockDelete.mockRejectedValue(new Error("Not found"));
      await expect(manager.deleteTurnstile("key")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("updateTurnstileDomains", () => {
    it("updates a widget's domains in invisible mode", async () => {
      const widget = { sitekey: "key-123", name: "my-site" };
      mockUpdate.mockResolvedValue(widget);

      const result = await manager.updateTurnstileDomains("key-123", ["a.com", "b.com"], "my-site");

      expect(result).toEqual(widget);
      expect(mockUpdate).toHaveBeenCalledWith(
        "key-123",
        { account_id: "acct-1", domains: ["a.com", "b.com"], mode: "invisible", name: "my-site" },
        opts,
      );
    });
  });

  describe("rotateTurnstile", () => {
    it("rotates the secret with immediate invalidation", async () => {
      const widget = { sitekey: "key-123", secret: "new-secret" };
      mockRotate.mockResolvedValue(widget);

      const result = await manager.rotateTurnstile("key-123");

      expect(result).toEqual(widget);
      expect(mockRotate).toHaveBeenCalledWith("key-123", { account_id: "acct-1", invalidate_immediately: true }, opts);
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockRotate.mockRejectedValue(new Error("Forbidden"));
      await expect(manager.rotateTurnstile("key")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when widgets are reachable", async () => {
      mockList.mockResolvedValue([]);
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when widgets are not reachable", async () => {
      mockList.mockRejectedValue(new Error("Unauthorized"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from verify on a bare-string rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("a bare string, not an Error"));
    await expect(manager.verify("t", "s")).rejects.toBeInstanceOf(PithyError);
  });
});
