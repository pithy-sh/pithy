import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { TypedKv } from "../../kv/kv";
import { CONTROL_PLANE_JTI_TTL_SECONDS } from "../token/claims";
import { controlPlaneKvNamespaces, kvReplayGuard, SeenJti } from "./replay";

/**
 * The guard against real Workers KV in workerd — the node suite proves the logic, this proves the
 * write actually lands in the store the capability registers, with the TTL it declares.
 *
 * Miniflare keeps the namespace between tests, so every test mints its own jti rather than trusting a
 * clean store. That is also how the seam behaves in production: a spent jti is never cleared, it
 * expires.
 */

const namespaces = controlPlaneKvNamespaces();
const jtiSpec = namespaces.controlplane.stores.jtis;

function store() {
  return new TypedKv(env.CONTROL_PLANE, jtiSpec);
}

const CONNECTION = "8f1c0c2e-0f2d-4a51-9a1f-1f2b3c4d5e6f";

function freshJti(): string {
  return crypto.randomUUID();
}

describe("kvReplayGuard over real KV", () => {
  test("the first claim wins and the second is refused", async () => {
    const guard = kvReplayGuard(store());
    const jti = freshJti();

    expect(await guard.claim(jti, CONNECTION)).toBe(true);
    expect(await guard.claim(jti, CONNECTION)).toBe(false);
  });

  test("a second guard over the same namespace sees the first one's claim", async () => {
    const jti = freshJti();
    await kvReplayGuard(store()).claim(jti, CONNECTION);

    // A replay reaches a different isolate, so the refusal must come from KV, not from instance state.
    expect(await kvReplayGuard(store()).claim(jti, CONNECTION)).toBe(false);
  });

  test("the receipt is stored under controlplane:jti:<id> and reads back as SeenJti", async () => {
    const jti = freshJti();
    await kvReplayGuard(store()).claim(jti, CONNECTION);

    const raw = await env.CONTROL_PLANE.get(`controlplane:jti:${jti}`, "text");
    expect(raw).not.toBeNull();
    expect(SeenJti.parse(JSON.parse(raw ?? "null")).connectionId).toBe(CONNECTION);
  });

  test("the receipt carries the declared TTL, so it outlives the token it spends", async () => {
    const jti = freshJti();
    await kvReplayGuard(store()).claim(jti, CONNECTION);

    const { keys } = await env.CONTROL_PLANE.list({ prefix: `controlplane:jti:${jti}` });
    expect(keys).toHaveLength(1);
    const expiration = keys[0]?.expiration;
    expect(expiration).toBeDefined();

    // KV reports an absolute expiry in seconds; allow a little slack for the round trip.
    const expected = Math.floor(Date.now() / 1000) + CONTROL_PLANE_JTI_TTL_SECONDS;
    expect(expiration ?? 0).toBeGreaterThan(expected - 10);
    expect(expiration ?? 0).toBeLessThanOrEqual(expected + 10);
  });
});
