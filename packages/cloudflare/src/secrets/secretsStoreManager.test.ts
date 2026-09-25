// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { clientError } from "@pithy-sh/core/src/error/client";
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

/**
 * One raw SDK list entry, as the wire hands it over. `comment` is declared optional rather than read
 * off {@link rawEntry}'s return type, because the absent key is the case worth driving: Cloudflare
 * returns no `comment` at all for an entry nothing annotated, and `undefined` is not `""`.
 */
interface RawEntry {
  id: string;
  name: string;
  status: string;
  store_id: string;
  created: string;
  modified: string;
  comment?: string;
}

/** A complete raw SDK list entry (the wire shape `CfSecretEntry` decodes). */
function rawEntry(id: string, name: string, extra: Partial<Omit<RawEntry, "id" | "name">> = {}): RawEntry {
  return {
    id,
    name,
    status: "active",
    store_id: "store-abc",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
    ...extra,
  };
}

/** Build a mock SDK paginator yielding the given entries, optionally throwing after them. */
function paginator(entries: RawEntry[], throwAfter?: Error) {
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
    it("decodes the explicit null Cloudflare really sends for an unannotated entry", () => {
      // **Found against a real store, and every mock in this file had missed it (#647).** The live list
      // returns `comment: null` for an entry nothing annotated — not an absent key. Declared `.optional()`
      // alone, this parse failed, `decodeResponse` raised `cloudflare/invalid_response`, and because
      // `entriesNamed` is what `updateExistingSecret` resolves a name through, the rotation's edit-only
      // write died on the first real store it touched. Every store has an unannotated entry in it.
      //
      // Drop `.nullable()` from CfSecretEntry.comment and this goes red.
      const wire = { ...rawEntry("id-null", "FOO"), comment: null };

      const decoded = CfSecretEntry.parse(wire);

      expect(decoded.comment).toBeNull();
    });

    it("survives a list in which only some entries are annotated", () => {
      // The shape of a real store: one entry this kit wrote a stamp on, beside an adopter's own secret
      // that nothing ever annotated. The batch must not fail because of the second one.
      const entries = [
        { ...rawEntry("id-a", "ANNOTATED"), comment: "pithy:rotation:r3" },
        { ...rawEntry("id-b", "PLAIN"), comment: null },
      ].map((wire) => CfSecretEntry.parse(wire));

      expect(entries.map((entry) => entry.comment)).toEqual(["pithy:rotation:r3", null]);
    });

    it("round-trips the ISO-string dates through JsonDate", () => {
      const wire = rawEntry("id-1", "FOO");
      const decoded = CfSecretEntry.parse(wire);
      expect(decoded.created).toEqual(new Date(wire.created));
      expect(decoded.modified).toEqual(new Date(wire.modified));
      const encoded = CfSecretEntry.encode(decoded);
      expect(encoded.created).toBe(wire.created);
      expect(encoded.modified).toBe(wire.modified);
    });

    /**
     * **`comment` is the only thing about a value REST can read back.** Cloudflare never returns a
     * secret's plaintext — values are bind-only by design — so a writer that wants to prove its write
     * reached the entry it addressed has this field and nothing else. It crosses the boundary in both
     * directions, and an entry Cloudflare returns without one decodes to `undefined` rather than `""`:
     * *unannotated* and *annotated with nothing* are different facts to a fail-closed reader.
     */
    it("carries the comment across the wire boundary in both directions", () => {
      const decoded = CfSecretEntry.parse(rawEntry("id-1", "FOO", { comment: "config v7" }));
      expect(decoded.comment).toBe("config v7");
      expect(CfSecretEntry.encode(decoded).comment).toBe("config v7");
    });

    it("leaves the comment undefined when Cloudflare returns none", () => {
      expect(CfSecretEntry.parse(rawEntry("id-1", "FOO")).comment).toBeUndefined();
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
      mockList.mockReturnValue(paginator([{ id: "id-1" } as RawEntry]));
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

    // The comment is a plain string here and nothing more: this client knows no payload shape, because
    // the only writer that needs one is `@pithy-sh/secrets`, and the codec belongs where it is read.
    it("carries a comment into the create body", async () => {
      mockList.mockReturnValue(paginator([]));
      mockCreate.mockResolvedValue([rawEntry("id-new", "FOO")]);

      await manager.putSecret("FOO", "value-1", "minted by provisioning");

      expect(mockCreate).toHaveBeenCalledWith("store-abc", {
        account_id: "test-account-id",
        body: [{ name: "FOO", value: "value-1", scopes: ["workers"], comment: "minted by provisioning" }],
      });
    });

    it("carries a comment into the edit params", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "FOO")]));
      mockEdit.mockResolvedValue({ id: "id-existing" });

      await manager.putSecret("FOO", "value-2", "rotated");

      expect(mockEdit.mock.calls).toHaveLength(1);
      expect(mockEdit.mock.calls[0]?.[1]).toMatchObject({ comment: "rotated" });
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

  /**
   * **Create, never overwrite, even when two runs race (#643).** And never answer "somebody else created it"
   * when this call cannot know that (F1 of the review): a create that throws may have landed server-side, so an
   * entry there afterwards is `unconfirmed`, not `present`. Nor rely on the store refusing a duplicate name, which
   * Cloudflare does not document: two entries of one name resolve to the oldest, and the younger removes itself.
   */
  describe("createSecretIfAbsent", () => {
    /** An entry of the given status and creation time. */
    function entry(id: string, status: "pending" | "active" | "deleted", created: string) {
      return { ...rawEntry(id, "FOO"), status, created };
    }

    it("creates when the name is absent, and says it did", async () => {
      mockList.mockReturnValueOnce(paginator([])).mockReturnValueOnce(paginator([rawEntry("id-new", "FOO")]));
      mockCreate.mockResolvedValue([rawEntry("id-new", "FOO")]);

      expect(await manager.createSecretIfAbsent("FOO", "value-1")).toBe("created");
      expect(mockCreate).toHaveBeenCalledWith("store-abc", {
        account_id: "test-account-id",
        body: [{ name: "FOO", value: "value-1", scopes: ["workers"] }],
      });
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("carries a comment into the create body", async () => {
      mockList.mockReturnValueOnce(paginator([])).mockReturnValueOnce(paginator([rawEntry("id-new", "FOO")]));
      mockCreate.mockResolvedValue([rawEntry("id-new", "FOO")]);

      await manager.createSecretIfAbsent("FOO", "value-1", "established");

      expect(mockCreate).toHaveBeenCalledWith("store-abc", {
        account_id: "test-account-id",
        body: [{ name: "FOO", value: "value-1", scopes: ["workers"], comment: "established" }],
      });
    });

    it("leaves an existing entry exactly as it is, and says it was present", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "FOO")]));

      expect(await manager.createSecretIfAbsent("FOO", "value-2")).toBe("present");
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockEdit).not.toHaveBeenCalled();
    });

    it("reads a create that threw with an entry there afterwards as unconfirmed — it may be this call's own", async () => {
      mockList.mockReturnValueOnce(paginator([])).mockReturnValueOnce(paginator([rawEntry("id-maybe-own", "FOO")]));
      mockCreate.mockRejectedValue(new Error("socket hang up"));

      expect(await manager.createSecretIfAbsent("FOO", "value")).toBe("unconfirmed");
      expect(mockEdit).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("throws a refused create when nothing is there afterwards — an outage is not a lost race", async () => {
      mockList.mockReturnValue(paginator([]));
      mockCreate.mockRejectedValue(new Error("Quota exceeded"));

      await expect(manager.createSecretIfAbsent("FOO", "value")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "Quota exceeded" }),
        }),
      );
      expect(mockEdit).not.toHaveBeenCalled();
    });

    it("does not count a deleted entry as there", async () => {
      mockList
        .mockReturnValueOnce(paginator([entry("id-gone", "deleted", "2026-01-01T00:00:00.000Z")]))
        .mockReturnValueOnce(
          paginator([
            entry("id-gone", "deleted", "2026-01-01T00:00:00.000Z"),
            entry("id-new", "active", "2026-02-01T00:00:00.000Z"),
          ]),
        );
      mockCreate.mockResolvedValue([rawEntry("id-new", "FOO")]);

      expect(await manager.createSecretIfAbsent("FOO", "value")).toBe("created");
    });

    it("counts a pending entry as there, so it is never created twice", async () => {
      mockList.mockReturnValue(paginator([entry("id-pending", "pending", "2026-01-01T00:00:00.000Z")]));

      expect(await manager.createSecretIfAbsent("FOO", "value")).toBe("present");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("removes its own entry when an older one of the same name landed beside it — never relying on a refusal", async () => {
      mockList
        .mockReturnValueOnce(paginator([]))
        .mockReturnValueOnce(
          paginator([
            entry("id-own", "active", "2026-01-01T00:00:02.000Z"),
            entry("id-winner", "active", "2026-01-01T00:00:01.000Z"),
          ]),
        );
      mockCreate.mockResolvedValue([rawEntry("id-own", "FOO")]);
      mockDelete.mockResolvedValue({ id: "id-own" });

      expect(await manager.createSecretIfAbsent("FOO", "loser")).toBe("present");
      expect(mockDelete).toHaveBeenCalledWith("id-own", { account_id: "test-account-id", store_id: "store-abc" });
    });
  });

  /**
   * **The verb that refuses to create, and the reason it had to exist.**
   *
   * `putSecret` upserts. A write addressed to a name nothing reads — a composed name gone stale, a
   * misspelled binding, an environment segment that never got substituted — finds no entry, creates
   * one, and answers 200. The caller hears success; the value it meant to replace is untouched and
   * still bound; an orphan entry nobody reads holds live key material. That is how a sibling codebase
   * lost an environment's secrets, with nothing returning an error anywhere. Here the absence is a
   * refusal, raised before anything is written.
   */
  describe("updateExistingSecret", () => {
    it("edits the entry of that name in place, returns its id, and never creates", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "SECRETS_CONFIG")]));
      mockEdit.mockResolvedValue({ id: "id-existing" });

      expect(await manager.updateExistingSecret("SECRETS_CONFIG", "envelope-2")).toBe("id-existing");

      expect(mockEdit).toHaveBeenCalledWith("id-existing", {
        account_id: "test-account-id",
        store_id: "store-abc",
        value: "envelope-2",
        scopes: ["workers"],
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("throws core/not_found and writes nothing when no entry carries the name", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-other", "SOMETHING_ELSE")]));

      await expect(manager.updateExistingSecret("SECRETS_CONFIG", "envelope-2")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "core/not_found" }) }),
      );
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockEdit).not.toHaveBeenCalled();
    });

    // A deleted entry is not one to write to (#643) — writing to it would be a write nothing resolves,
    // which is the whole failure this verb exists to refuse.
    it("does not count a deleted entry as one to update", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-gone", "SECRETS_CONFIG", { status: "deleted" })]));

      await expect(manager.updateExistingSecret("SECRETS_CONFIG", "envelope-2")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "core/not_found" }) }),
      );
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockEdit).not.toHaveBeenCalled();
    });

    // Two entries of one name is exactly what a misnamed write leaves behind. Editing the older of them
    // is a coin toss over which value the binding goes on serving, so the ambiguity is reported instead.
    it("throws core/conflict and writes nothing when two live entries carry the name", async () => {
      mockList.mockReturnValue(
        paginator([
          rawEntry("id-one", "SECRETS_CONFIG", { created: "2026-01-01T00:00:01.000Z" }),
          rawEntry("id-two", "SECRETS_CONFIG", { created: "2026-01-01T00:00:02.000Z" }),
        ]),
      );

      await expect(manager.updateExistingSecret("SECRETS_CONFIG", "envelope-2")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "core/conflict" }) }),
      );
      expect(mockEdit).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("counts only the live entries when it decides the name is ambiguous", async () => {
      mockList.mockReturnValue(
        paginator([
          rawEntry("id-gone", "SECRETS_CONFIG", { status: "deleted", created: "2026-01-01T00:00:01.000Z" }),
          rawEntry("id-live", "SECRETS_CONFIG", { created: "2026-01-01T00:00:02.000Z" }),
        ]),
      );
      mockEdit.mockResolvedValue({ id: "id-live" });

      expect(await manager.updateExistingSecret("SECRETS_CONFIG", "envelope-2")).toBe("id-live");
    });

    it("sets the comment when one is given, and sends no comment field at all when none is", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "SECRETS_CONFIG")]));
      mockEdit.mockResolvedValue({ id: "id-existing" });

      await manager.updateExistingSecret("SECRETS_CONFIG", "envelope-2", "v7");
      await manager.updateExistingSecret("SECRETS_CONFIG", "envelope-3");

      expect(mockEdit.mock.calls).toHaveLength(2);
      expect(mockEdit.mock.calls[0]?.[1]).toMatchObject({ comment: "v7" });
      expect(mockEdit.mock.calls[1]?.[1]).not.toHaveProperty("comment");
    });

    /**
     * #386: a failure's own text, and anything derived from key material, reaches no client. `detail`
     * is the throw site's and carries the upstream text verbatim — that is what it is for. Nothing a
     * client is handed does, and `clientError` is the one boundary that decides it (#344), so the whole
     * projection is what is asserted rather than two fields of the payload.
     */
    it("keeps the value out of everything a client is handed, even when the upstream echoes it", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-existing", "SECRETS_CONFIG")]));
      mockEdit.mockRejectedValue(new Error("rejected value new-envelope"));

      let thrown: unknown;
      try {
        await manager.updateExistingSecret("SECRETS_CONFIG", "new-envelope");
      } catch (error) {
        thrown = error;
      }

      if (!(thrown instanceof PithyError)) throw new Error("updateExistingSecret resolved; expected it to refuse.");
      expect(thrown.payload.code).toBe("cloudflare/request_failed");
      expect(thrown.payload.detail).toContain("new-envelope");
      expect(JSON.stringify(clientError(thrown.payload))).not.toContain("new-envelope");
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  /**
   * **The plural is the point.** Cloudflare does not document that the store refuses a duplicate name,
   * and #643 established that it does not — so "the entry named X" is a claim rather than a given. A
   * caller whose correctness depends on it asserts `length === 1` here and says what it wants done when
   * that is false. Every verb in this manager resolves a name through this one answer.
   */
  describe("entriesNamed", () => {
    it("returns every live entry of the name, oldest first", async () => {
      mockList.mockReturnValue(
        paginator([
          rawEntry("id-young", "FOO", { created: "2026-02-01T00:00:00.000Z" }),
          rawEntry("id-old", "FOO", { created: "2026-01-01T00:00:00.000Z" }),
        ]),
      );

      expect((await manager.entriesNamed("FOO")).map((entry) => entry.id)).toEqual(["id-old", "id-young"]);
    });

    it("leaves out a deleted entry, and another name's", async () => {
      mockList.mockReturnValue(
        paginator([
          rawEntry("id-live", "FOO"),
          rawEntry("id-gone", "FOO", { status: "deleted" }),
          rawEntry("id-other", "BAR"),
        ]),
      );

      expect((await manager.entriesNamed("FOO")).map((entry) => entry.id)).toEqual(["id-live"]);
    });

    it("answers [] for a name nothing in the store carries", async () => {
      mockList.mockReturnValue(paginator([rawEntry("id-other", "BAR")]));

      expect(await manager.entriesNamed("FOO")).toEqual([]);
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
