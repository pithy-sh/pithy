// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { parseCompactJws } from "@pithy-sh/core/src/controlPlane/token/jws";
import { exportPublicJwk } from "@pithy-sh/core/src/controlPlane/token/mint";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { controlPlaneCaller, fillPath, keyCredential, queryString, trustCredential } from "./caller";
import { generateAgentKey, importSigningKey } from "./keyFile";

const CONNECTION = "5f0c8f3e-8a0e-4d55-9a37-6b1f7d2a9c11";

/** The payload of a compact JWS, read without verifying. */
function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8"));
}

async function signer() {
  const key = await generateAgentKey("mcp-1");
  return keyCredential({
    privateKey: await importSigningKey(key),
    keyId: "mcp-1",
    issuer: "urn:pithy:mcp",
    connectionId: CONNECTION,
    subject: "pithy-acme-prod",
  });
}

describe("fillPath and queryString", () => {
  test("fill each parameter, encoded so it stays one segment", () => {
    expect(fillPath("/ledger/admin/accounts/:userId/:currency/credit", { userId: "u/1", currency: "gold" })).toBe(
      "/ledger/admin/accounts/u%2F1/gold/credit",
    );
    expect(fillPath("/a/:id{[0-9]+}", { id: 7 })).toBe("/a/7");
  });

  test("a missing parameter is refused naming it", () => {
    expect(() => fillPath("/support/threads/:id", {})).toThrow(PithyError);
  });

  test("a query repeats arrays and leaves out what is absent", () => {
    expect(queryString({ q: "a b", tag: ["x", "y"], none: undefined, n: 3 })).toBe("?q=a+b&tag=x&tag=y&n=3");
    expect(queryString({})).toBe("");
  });
});

describe("a key call", () => {
  test("mints one token per call naming the route's scope and bound to the body, on the seam's header", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const caller = controlPlaneCaller({ workerUrl: "https://w.example/prefix/", credential: await signer(), fetch });
    const result = await caller.call(
      { method: "POST", path: "/support/threads/:id/reply", scope: "support:threads:reply" },
      { path: { id: "t1" }, body: { text: "hi" } },
    );
    expect(result).toEqual({ status: 200, body: { ok: true } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://w.example/prefix/support/threads/t1/reply");
    const token = init.headers["pithy-control-plane"] as string;
    const claims = claimsOf(token);
    expect(claims.scope).toBe("support:threads:reply");
    expect(claims.aud).toBe(CONNECTION);
    expect(claims.iss).toBe("urn:pithy:mcp");
    expect(claims.bodySha256).not.toBeNull();
    expect(parseCompactJws(token).header.kid).toBe("mcp-1");
    expect(init.headers["pithy-control-plane-oidc"]).toBeUndefined();
  });

  test("two calls mint two tokens", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const caller = controlPlaneCaller({ workerUrl: "https://w.example", credential: await signer(), fetch });
    await caller.call({ method: "GET", path: "/x", scope: "a:read" });
    await caller.call({ method: "GET", path: "/x", scope: "a:read" });
    const tokens = fetch.mock.calls.map(
      (call) => (call as unknown as [string, { headers: Record<string, string> }])[1].headers["pithy-control-plane"],
    );
    expect(new Set(tokens).size).toBe(2);
  });

  test("the Ed25519 key it signs with exports to the public half registered", async () => {
    const key = await generateAgentKey("mcp-1");
    const pair = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: key.x }, "Ed25519", true, [
      "verify",
    ]);
    expect((await exportPublicJwk(pair)).x).toBe(key.x);
  });
});

describe("a trust call", () => {
  test("presents the workload token, the trust and the call's scope, and no signed token", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const caller = controlPlaneCaller({
      workerUrl: "https://w.example",
      credential: trustCredential({ trustId: "trust-1", tokens: { current: async () => "workload.jwt.sig" } }),
      fetch,
    });
    await caller.call(
      { method: "GET", path: "/support/threads", scope: "support:threads:read" },
      { query: { q: "x" } },
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://w.example/support/threads?q=x");
    expect(init.headers).toMatchObject({
      "pithy-control-plane-oidc": "workload.jwt.sig",
      "pithy-control-plane-trust": "trust-1",
      "pithy-control-plane-scope": "support:threads:read",
    });
    expect(init.headers["pithy-control-plane"]).toBeUndefined();
  });
});

describe("an unreachable Worker", () => {
  test("is an upstream failure naming the Worker", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const caller = controlPlaneCaller({ workerUrl: "https://w.example", credential: await signer(), fetch });
    const refusal = await caller.call({ method: "GET", path: "/x", scope: "a:read" }).catch((error: unknown) => error);
    expect((refusal as PithyError).payload.code).toBe("core/upstream_failed");
  });
});
