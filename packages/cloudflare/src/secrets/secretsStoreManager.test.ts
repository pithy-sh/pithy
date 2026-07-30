// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CfSecretEntry, CloudflareSecretsStoreManager } from "./secretsStoreManager";

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockEdit = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    secretsStore = {
      stores: {
        secrets: {
          list: mockList,
          create: mockCreate,
          delete: mockDelete,
          edit: mockEdit,
        },
      },
    };
  },
}));

/** A complete raw SDK list entry (the wire shape `CfSecretEntry` decodes). */
function rawEntry(id: string, name: string) {
  return {
    id,
    name,
    status: "active",
    store_id: "store-abc",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
  };
}

/** Build a mock SDK paginator yielding the given entries, optionally throwing after them. */
function paginator(entries: ReturnType<typeof rawEntry>[], throwAfter?: Error) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const entry of entries) yield entry;
      if (throwAfter) throw throwAfter;
    },
  };
}

describe("CloudflareSecretsStoreManager", () => {
  const config = { accountId: "test-account-id", apiToken: "test-api-token", storeId: "store-abc" };
  let manager: CloudflareSecretsStoreManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareSecretsStoreManager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type and store info", () => {
      expect(manager.getServiceType()).toBe("Cloudflare Secrets Store");
      expect(manager.getSecretsStoreInfo()).toEqual({ storeId: "store-abc", accountId: "test-account-id" });
    });

    it("throws cloudflare/not_configured when storeId is missing", () => {
      expect(() => new CloudflareSecretsStoreManager({ ...config, storeId: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws cloudflare/not_configured when apiToken is missing (base guard)", () => {
      expect(() => new CloudflareSecretsStoreManager({ ...config, apiToken: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("CfSecretEntry codec", () => {
    it("round-trips the ISO-string dates through JsonDate", () => {
      const wire = rawEntry("id-1", "FOO");
      const decoded = CfSecretEntry.parse(wire);
      expect(decoded.created).toEqual(new Date(wire.created));
      expect(decoded.modified).toEqual(new Date(wire.modified));
      const encoded = CfSecretEntry.encode(decoded);
      expect(encoded.created).toBe(wire.created);
      expect(encoded.modified).toBe(wire.modified);
    });
  });

  describe("listSecrets", () => {
    it("iterates the SDK paginator and returns decoded entries", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-1", "FOO"), rawEntry("id-2", "BAR")]));

      const result = await manager.listSecrets();

      expect(mockList).toHaveBeenCalledWith("store-abc", { account_id: "test-account-id" });
      expect(result.map((e) => ({ id: e.id, name: e.name }))).toEqual([
        { id: "id-1", name: "FOO" },
        { id: "id-2", name: "BAR" },
      ]);
      expect(result[0]?.created).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    });

    it("throws cloudflare/invalid_response when an entry has the wrong shape", async () => {
      mockList.mockReturnValue(paginator([{ id: "id-1" } as ReturnType<typeof rawEntry>]));
      await expect(manager.listSecrets()).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause kept in detail", async () => {
      mockList.mockReturnValue(paginator([], new Error("Unauthorized")));
      await expect(manager.listSecrets()).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "Unauthorized" }),
        }),
      );
    });
  });

  describe("putSecret", () => {
    it("creates when the secret does not yet exist", async () => {
      mockList.mockReturnValue(paginator([]));
      mockCreate.mockResolvedValue([rawEntry("id-new", "FOO")]);

      await manager.putSecret("FOO", "value-1");

      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith("store-abc", {
        account_id: "test-account-id",
        body: [{ name: "FOO", value: "value-1", scopes: ["workers"] }],
      });
    });

    it("edits in place when the secret already exists — never deletes first", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "FOO")]));
      mockEdit.mockResolvedValue({ id: "id-existing" });

      await manager.putSecret("FOO", "value-2");

      expect(mockEdit).toHaveBeenCalledWith("id-existing", {
        account_id: "test-account-id",
        store_id: "store-abc",
        value: "value-2",
        scopes: ["workers"],
      });
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("wraps a create failure as cloudflare/request_failed", async () => {
      mockList.mockReturnValue(paginator([]));
      mockCreate.mockRejectedValue(new Error("Quota exceeded"));

      await expect(manager.putSecret("FOO", "value")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "Quota exceeded" }),
        }),
      );
    });

    // The reason `putSecret` uses `edit` rather than delete-then-create: a failed update must leave
    // the prior value bound. For the master encryption key, an absent secret is a platform outage —
    // every stored secret becomes undecryptable — so "never delete first" is the load-bearing property.
    it("leaves the existing secret intact when the edit fails", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "SECRETS_CONFIG")]));
      mockEdit.mockRejectedValue(new Error("transient 5xx"));

      await expect(manager.putSecret("SECRETS_CONFIG", "new-envelope")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "transient 5xx" }),
        }),
      );

      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("does not leak the plaintext value into the error", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "SECRETS_CONFIG")]));
      mockEdit.mockRejectedValue(new Error("upstream-fail"));

      let err: PithyError | undefined;
      try {
        await manager.putSecret("SECRETS_CONFIG", "new-envelope");
      } catch (e) {
        err = e as PithyError;
      }

      expect(err).toBeInstanceOf(PithyError);
      expect(err?.payload.message).not.toContain("new-envelope");
      expect(err?.payload.detail).not.toContain("new-envelope");
    });
  });

  describe("deleteSecret", () => {
    it("deletes by id resolved from listSecrets", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-1", "FOO")]));
      mockDelete.mockResolvedValue({ id: "id-1" });

      await manager.deleteSecret("FOO");

      expect(mockDelete).toHaveBeenCalledWith("id-1", { account_id: "test-account-id", store_id: "store-abc" });
    });

    it("throws core/not_found when the secret is not present", async () => {
      mockList.mockReturnValue(paginator([]));

      await expect(manager.deleteSecret("MISSING")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "core/not_found" }) }),
      );
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("wraps a delete failure as cloudflare/request_failed", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-1", "FOO")]));
      mockDelete.mockRejectedValue(new Error("Conflict"));

      await expect(manager.deleteSecret("FOO")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "Conflict" }),
        }),
      );
    });
  });

  describe("exists", () => {
    it("returns true when a secret with the name is present", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-1", "FOO")]));
      expect(await manager.exists("FOO")).toBe(true);
    });

    it("returns false when no secret matches", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-1", "FOO")]));
      expect(await manager.exists("BAR")).toBe(false);
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when listSecrets succeeds", async () => {
      mockList.mockReturnValue(paginator([]));
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when listSecrets fails", async () => {
      mockList.mockReturnValue(paginator([], new Error("Unauthorized")));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockList.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield* [];
        throw "a bare string, not an Error";
      },
    });
    await expect(manager.listSecrets()).rejects.toBeInstanceOf(PithyError);
  });
});
