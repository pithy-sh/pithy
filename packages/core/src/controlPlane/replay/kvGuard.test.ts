// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KVNamespace } from "@cloudflare/workers-types";
import { describe, expect, test } from "vitest";
import { TypedKv } from "../../kv/kv";
import { CONTROL_PLANE_JTI_TTL_SECONDS } from "../token/claims";
import {
  CONTROL_PLANE_KV_BINDING,
  CONTROL_PLANE_KV_PREFIX,
  controlPlaneKvNamespaces,
  kvReplayGuard,
  SeenJti,
} from "./kvGuard";

/**
 * An in-memory stand-in for the KV binding, not for {@link TypedKv} — the guard is driven through the
 * real typed store built from the real store spec, so these tests exercise the actual key shape, the
 * actual Zod validation, and the actual TTL rather than a hand-written double of them. It records the
 * raw bytes and the put options, which is how the stored-value and TTL assertions can be honest.
 */
function fakeBinding() {
  const entries = new Map<string, { value: string; expirationTtl?: number }>();
  const binding = {
    async get(name: string): Promise<string | null> {
      return entries.get(name)?.value ?? null;
    },
    async put(name: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      entries.set(name, { value, expirationTtl: options?.expirationTtl });
    },
    async delete(name: string): Promise<void> {
      entries.delete(name);
    },
  };
  return { entries, binding: binding as unknown as KVNamespace };
}

const namespaces = controlPlaneKvNamespaces();
const jtiSpec = namespaces.controlplane.stores.jtis;

function guardOverFake() {
  const { entries, binding } = fakeBinding();
  return { entries, guard: kvReplayGuard(new TypedKv(binding, jtiSpec)) };
}

const CONNECTION = "8f1c0c2e-0f2d-4a51-9a1f-1f2b3c4d5e6f";

describe("the jti store's wiring", () => {
  test("the physical key reads controlplane:jti:<id>", () => {
    const store = new TypedKv(fakeBinding().binding, jtiSpec);
    expect(store.name({ scope: "jti", jti: "abc123" })).toBe("controlplane:jti:abc123");
  });

  test("the namespace registers the CONTROL_PLANE binding and a jtis store on the jti TTL", () => {
    expect(namespaces.controlplane.binding).toBe(CONTROL_PLANE_KV_BINDING);
    expect(jtiSpec.prefix).toBe(CONTROL_PLANE_KV_PREFIX);
    expect(jtiSpec.ttlSeconds).toBe(CONTROL_PLANE_JTI_TTL_SECONDS);
  });

  test("a jti past the key's length bound is refused before anything is written", async () => {
    const { entries, guard } = guardOverFake();
    await expect(guard.claim("j".repeat(129), CONNECTION)).rejects.toThrow();
    expect(entries.size).toBe(0);
  });
});

describe("kvReplayGuard", () => {
  test("the first claim on a jti wins", async () => {
    const { guard } = guardOverFake();
    await expect(guard.claim("token-1", CONNECTION)).resolves.toBe(true);
  });

  test("a second claim on the same jti is refused — the caller must deny", async () => {
    const { guard } = guardOverFake();
    await guard.claim("token-1", CONNECTION);
    await expect(guard.claim("token-1", CONNECTION)).resolves.toBe(false);
  });

  test("a replay from a different connection is refused too — the jti is the whole key", async () => {
    const { guard } = guardOverFake();
    await guard.claim("token-1", CONNECTION);
    await expect(guard.claim("token-1", "3c9d0b7a-1111-4222-8333-444455556666")).resolves.toBe(false);
  });

  test("distinct jtis are independent", async () => {
    const { guard } = guardOverFake();
    expect(await guard.claim("token-1", CONNECTION)).toBe(true);
    expect(await guard.claim("token-2", CONNECTION)).toBe(true);
  });

  test("what it stores validates as SeenJti and names the claiming connection", async () => {
    const { entries, guard } = guardOverFake();
    const before = Date.now();
    await guard.claim("token-1", CONNECTION);

    const stored = entries.get("controlplane:jti:token-1");
    expect(stored).toBeDefined();
    const parsed = SeenJti.parse(JSON.parse(stored?.value ?? "null"));
    expect(parsed.connectionId).toBe(CONNECTION);
    expect(parsed.seenAt).toBeGreaterThanOrEqual(before);
    expect(parsed.seenAt).toBeLessThanOrEqual(Date.now());
  });

  test("the claim carries the jti TTL, so the record outlives the token it spends", async () => {
    const { entries, guard } = guardOverFake();
    await guard.claim("token-1", CONNECTION);
    expect(entries.get("controlplane:jti:token-1")?.expirationTtl).toBe(CONTROL_PLANE_JTI_TTL_SECONDS);
  });
});

/**
 * The limit that moved the default to D1, pinned as a test rather than left as a paragraph.
 *
 * This is not a defect in `kvReplayGuard` — read-then-write is the strongest claim Workers KV offers.
 * It is the reason `replayBackend` defaults to `d1`, whose companion test
 * (`d1Guard.workers.test.ts`) runs the same race and admits exactly one caller.
 */
describe("the cross-colocation window", () => {
  /**
   * A binding whose `put` is not visible to a read issued before it converges — one propagation window,
   * which is precisely what KV offers no way to close.
   */
  function laggingBinding() {
    const committed = new Map<string, string>();
    let pending: Array<() => void> = [];
    const binding = {
      async get(name: string): Promise<string | null> {
        return committed.get(name) ?? null;
      },
      async put(name: string, value: string): Promise<void> {
        pending.push(() => committed.set(name, value));
      },
      async delete(name: string): Promise<void> {
        committed.delete(name);
      },
    };
    return {
      binding: binding as unknown as KVNamespace,
      converge: () => {
        const apply = pending;
        pending = [];
        for (const write of apply) write();
      },
    };
  }

  test("two colocations presenting one token inside the window both claim it", async () => {
    const { binding, converge } = laggingBinding();
    const guard = kvReplayGuard(new TypedKv(binding, jtiSpec));

    // Both calls read before either write has propagated, so both see a miss. Under D1 this is one
    // insert and one conflict; here it is two claims, and the caller admits the replay.
    const outcomes = await Promise.all([guard.claim("token-race", CONNECTION), guard.claim("token-race", CONNECTION)]);
    expect(outcomes).toEqual([true, true]);

    // Once the write converges the guard behaves as documented — the window is at the very start of a
    // token's life, not at the end of it.
    converge();
    expect(await guard.claim("token-race", CONNECTION)).toBe(false);
  });
});
