// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { CALLER_TOKEN_SECRET, callerTokenRegistry, verifyCallerRequest } from "./request";
import { CALLER_TOKEN_HEADER, type CallerTokenVerdict, mintCallerToken } from "./token";

/**
 * **The caller-token verifier, reading its key the one way a secret is read (#560).**
 *
 * CLAUDE.md's secret rule: every secret is declared in a registry and read through `secretsStore`, never
 * off a raw `env.X` binding. A key that could arrive as a plaintext Worker var is one an adopter will set
 * as a plaintext Worker var, and then it sits in `wrangler.jsonc` and in every log that prints the env.
 */

const AUDIENCE = "https://api.example.com";
const KEY = "caller-token-key-from-the-store-000000000";

/** A probe app that answers the verifier's verdict, with every env property it touched recorded. */
function probeApp() {
  const touched = new Set<string>();
  const recorded = new Proxy(env as unknown as Record<string, unknown>, {
    get(target, key) {
      if (typeof key === "string") touched.add(key);
      return Reflect.get(target, key);
    },
  });
  const app = new Hono<PithyHonoEnv>();
  app.get("/probe", async (c) => c.json(await verifyCallerRequest(c, { audience: AUDIENCE })));
  const ask = async (headers: Record<string, string> = {}) =>
    (await app.request("/probe", { headers }, recorded)).json<CallerTokenVerdict>();
  return { ask, touched };
}

beforeEach(async () => {
  await seedSecrets(env, callerTokenRegistry, { [CALLER_TOKEN_SECRET]: KEY });
});

describe("verifyCallerRequest", () => {
  test("trusts a token signed with the key the secrets store holds", async () => {
    const { ask } = probeApp();
    const token = await mintCallerToken({ key: KEY, kid: "1", audience: AUDIENCE });
    expect((await ask({ [CALLER_TOKEN_HEADER]: token })).trusted).toBe(true);
  });

  test("reads the key through secretsStore and never off a raw env binding", async () => {
    // A plaintext binding under the secret's own name, holding a different key. A verifier reading
    // `env[name]` would trust the token signed with it; the store's key would not.
    const { ask, touched } = probeApp();
    const raw = { ...(env as unknown as Record<string, unknown>), [CALLER_TOKEN_SECRET]: "a-plaintext-var" };
    const app = new Hono<PithyHonoEnv>();
    app.get("/probe", async (c) => c.json(await verifyCallerRequest(c, { audience: AUDIENCE })));
    const forged = await mintCallerToken({ key: "a-plaintext-var", kid: "1", audience: AUDIENCE });
    const res = await app.request("/probe", { headers: { [CALLER_TOKEN_HEADER]: forged } }, raw);
    expect(await res.json<CallerTokenVerdict>()).toEqual({ trusted: false, reason: "signature" });

    const genuine = await mintCallerToken({ key: KEY, kid: "1", audience: AUDIENCE });
    expect((await ask({ [CALLER_TOKEN_HEADER]: genuine })).trusted).toBe(true);
    expect(touched.has(CALLER_TOKEN_SECRET)).toBe(false);
  });

  test("answers absent for a request with no token, and reads no secret to say so", async () => {
    const { ask, touched } = probeApp();
    expect(await ask()).toEqual({ trusted: false, reason: "absent" });
    expect(touched.has("SECRETS")).toBe(false);
  });

  test("refuses a token presented on Authorization, which carries the forwarded session and nothing else", async () => {
    const { ask } = probeApp();
    const token = await mintCallerToken({ key: KEY, kid: "1", audience: AUDIENCE });
    expect(await ask({ authorization: `Bearer ${token}` })).toEqual({ trusted: false, reason: "absent" });
  });
});
