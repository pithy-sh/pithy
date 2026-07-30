// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ControlPlaneKeyConflictError, ControlPlaneKeyNotFoundError } from "../error/errors";
import type { Ed25519PublicJwk, RegisteredKey } from "./connection";
import { activeKeys, appendKey, expireKey, findVerifyingKey, pruneKeys } from "./keyLifecycle";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const jwk = (x: string): Ed25519PublicJwk => ({ kty: "OKP", crv: "Ed25519", x });

const key = (keyId: string, over: Partial<RegisteredKey> = {}): RegisteredKey => ({
  keyId,
  publicKey: jwk(`x-${keyId}`),
  validFrom: at(-DAY),
  validUntil: null,
  revokedAt: null,
  ...over,
});

describe("activeKeys", () => {
  it("treats two live keys as a normal state — the rotation overlap is the design, not an anomaly", () => {
    const keys = [key("old"), key("new", { validFrom: at(-MINUTE) })];
    expect(activeKeys(keys, NOW).map((k) => k.keyId)).toEqual(["old", "new"]);
  });

  it("excludes a key registered ahead of its validFrom, so a key cannot be used early", () => {
    const keys = [key("old"), key("future", { validFrom: at(DAY) })];
    expect(activeKeys(keys, NOW).map((k) => k.keyId)).toEqual(["old"]);
  });

  it("excludes a key whose window has closed, and keeps one closing exactly now open until it passes", () => {
    const keys = [key("closed", { validUntil: at(-MINUTE) }), key("closing", { validUntil: at(MINUTE) })];
    expect(activeKeys(keys, NOW).map((k) => k.keyId)).toEqual(["closing"]);
  });

  it("rejects a revoked key immediately, ignoring an open-ended or future validUntil", () => {
    const revoked = key("revoked", { validUntil: at(DAY), revokedAt: at(-MINUTE) });
    expect(activeKeys([revoked], NOW)).toEqual([]);
    expect(findVerifyingKey([revoked], "revoked", NOW)).toBeNull();
  });
});

describe("findVerifyingKey", () => {
  it("returns the named key when it is live", () => {
    const keys = [key("old"), key("new")];
    expect(findVerifyingKey(keys, "new", NOW)?.keyId).toBe("new");
  });

  it("returns null for a kid nobody registered, rather than falling back to another key", () => {
    expect(findVerifyingKey([key("old")], "attacker", NOW)).toBeNull();
  });
});

describe("appendKey", () => {
  it("leaves every existing key's validUntil untouched — appending is not half a rotation", () => {
    const keys = [key("old")];
    const appended = appendKey(keys, key("new"), NOW);
    expect(appended.map((k) => k.validUntil)).toEqual([null, null]);
    expect(keys).toEqual([key("old")]); // the input array is never mutated
  });

  it("refuses a keyId that is already registered", () => {
    expect(() => appendKey([key("old")], key("old"), NOW)).toThrow(ControlPlaneKeyConflictError);
  });

  it("refuses a key that is already dead on arrival — it could never be proven by a ping", () => {
    expect(() => appendKey([key("old")], key("stale", { validUntil: at(-MINUTE) }), NOW)).toThrow(
      ControlPlaneKeyConflictError,
    );
    expect(() => appendKey([key("old")], key("dead", { revokedAt: at(-MINUTE) }), NOW)).toThrow(
      ControlPlaneKeyConflictError,
    );
  });
});

describe("the rotation safety property (issue #80 definition of done)", () => {
  it("a failed rotation never expires the old key", () => {
    const before = [key("old")];

    // The management client registers its replacement. That is the whole of step one.
    const after = appendKey(before, key("new"), NOW);

    // Step two never happens: the ping does not come back, so `expireKey` is never called.
    const old = after.find((k) => k.keyId === "old");
    expect(old?.validUntil).toBeNull();
    expect(findVerifyingKey(after, "old", NOW)?.keyId).toBe("old");
  });

  it("a connection survives the Worker being unreachable for the full retry budget", () => {
    const after = appendKey([key("old")], key("new"), NOW);

    // Days of failed pings later, with only the append having landed, the old key still verifies.
    for (const elapsed of [MINUTE, DAY, 30 * DAY, 365 * DAY]) {
      expect(findVerifyingKey(after, "old", at(elapsed))?.keyId).toBe("old");
    }
  });
});

describe("expireKey", () => {
  it("closes the named key's window at now and leaves the proven key open-ended", () => {
    const keys = appendKey([key("old")], key("new"), NOW);
    const rotated = expireKey(keys, "old", { provenKeyId: "new", now: NOW });

    expect(rotated.find((k) => k.keyId === "old")?.validUntil).toEqual(NOW);
    expect(rotated.find((k) => k.keyId === "new")?.validUntil).toBeNull();
    expect(activeKeys(rotated, at(MINUTE)).map((k) => k.keyId)).toEqual(["new"]);
    expect(keys.find((k) => k.keyId === "old")?.validUntil).toBeNull(); // input untouched
  });

  it("refuses a keyId nobody registered", () => {
    const keys = [key("old"), key("new")];
    expect(() => expireKey(keys, "ghost", { provenKeyId: "new", now: NOW })).toThrow(ControlPlaneKeyNotFoundError);
  });

  it("refuses when the replacement has not been proven — a key that is not live proves nothing", () => {
    const notYetValid = appendKey([key("old")], key("new", { validFrom: at(DAY) }), NOW);
    expect(() => expireKey(notYetValid, "old", { provenKeyId: "new", now: NOW })).toThrow(ControlPlaneKeyConflictError);

    const unknownProver = [key("old"), key("new")];
    expect(() => expireKey(unknownProver, "old", { provenKeyId: "never-registered", now: NOW })).toThrow(
      ControlPlaneKeyConflictError,
    );
  });

  it("refuses when expiring would leave no live key — the lockout case", () => {
    const only = [key("only")];
    expect(() => expireKey(only, "only", { provenKeyId: "only", now: NOW })).toThrow(ControlPlaneKeyConflictError);
    expect(activeKeys(only, NOW).map((k) => k.keyId)).toEqual(["only"]);
  });

  it("re-expiring an already-closed key does not reopen it or move its end date", () => {
    const keys = expireKey(appendKey([key("old")], key("new"), NOW), "old", { provenKeyId: "new", now: NOW });
    const again = expireKey(keys, "old", { provenKeyId: "new", now: at(DAY) });
    expect(again.find((k) => k.keyId === "old")?.validUntil).toEqual(NOW);
  });
});

describe("pruneKeys", () => {
  const options = { now: NOW, retentionMs: 30 * DAY, maxKeys: 3 };

  it("drops keys retired longer ago than the retention window", () => {
    const keys = [key("ancient", { validUntil: at(-90 * DAY) }), key("recent", { validUntil: at(-DAY) }), key("live")];
    expect(pruneKeys(keys, options).map((k) => k.keyId)).toEqual(["recent", "live"]);
  });

  it("drops a long-revoked key on its revokedAt, not its validUntil", () => {
    const keys = [key("burned", { validUntil: at(DAY), revokedAt: at(-90 * DAY) }), key("live")];
    expect(pruneKeys(keys, options).map((k) => k.keyId)).toEqual(["live"]);
  });

  it("never drops a live key, however many there are and however small the cap", () => {
    const keys = [key("a"), key("b"), key("c"), key("d")];
    expect(pruneKeys(keys, { ...options, maxKeys: 1 }).map((k) => k.keyId)).toEqual(["a", "b", "c", "d"]);
  });

  it("never drops a key registered ahead of its validFrom — it is unretired, not dead", () => {
    const keys = [key("live"), key("future", { validFrom: at(DAY) })];
    expect(pruneKeys(keys, { ...options, maxKeys: 1, retentionMs: 0 }).map((k) => k.keyId)).toEqual(["live", "future"]);
  });

  it("caps the array by dropping the oldest retired keys first, keeping insertion order", () => {
    const keys = [
      key("r1", { validUntil: at(-3 * DAY) }),
      key("r2", { validUntil: at(-2 * DAY) }),
      key("r3", { validUntil: at(-DAY) }),
      key("live"),
    ];
    expect(pruneKeys(keys, { ...options, maxKeys: 2 }).map((k) => k.keyId)).toEqual(["r3", "live"]);
  });

  it("returns the array unchanged when nothing is retired and the cap is not reached", () => {
    const keys = [key("old"), key("new")];
    expect(pruneKeys(keys, options)).toEqual(keys);
  });
});
