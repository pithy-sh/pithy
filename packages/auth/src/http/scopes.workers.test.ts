// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createLogger } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type AuthOptions, auth } from "../capability";
import {
  prepareScopedBackend,
  SCOPED_ORIGIN,
  SCOPED_REGISTRY,
  scopedWorkerEnv,
  signInScoped,
} from "../test-utils/scopedBackend";
import { requireAuth } from "./middleware";

/**
 * **`resolveScopes`: the seam that fills `AuthContext.scopes`, through a real `auth()` (#560).**
 *
 * The array was declared in core, written `[]` by the session middleware on every request, and read by
 * four gates — each of which was tested against a stub that filled it. So every gate passed and none could
 * open. Nothing here stubs the middleware: the backend composes the real capability, the user signs in
 * with the real Better Auth instance, and the probe reads what the real middleware put on the request.
 */

/** What the probe reports: the request's scopes, exactly as a gate would read them. */
interface Probe {
  scopes: string[] | null;
}

/** A probe on the app capability, behind `requireAuth()` the way every gated route is. */
const probe = defineCapability({
  name: "probe",
  requiredBindings: [],
  routes: (app) => {
    const read = (c: { var: { auth: { scopes: string[] } | null } }) => ({ scopes: c.var.auth?.scopes ?? null });
    app.get("/probe", requireAuth(), (c) => c.json<Probe>(read(c)));
    app.post("/probe", requireAuth(), (c) => c.json<Probe>(read(c)));
  },
});

/** Every log record the backend wrote, so a test can assert the warning a failed resolver leaves. */
let records: LogRecord[];

/** One backend: secrets, email, and the real auth under test, with the probe as the app. */
function buildApp(options: Partial<AuthOptions> = {}) {
  return createBackend({
    capabilities: [
      secrets({ registry: SCOPED_REGISTRY }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: SCOPED_ORIGIN }),
      auth({ baseURL: SCOPED_ORIGIN, basePath: "/auth", trustedOrigins: [SCOPED_ORIGIN], ...options }),
    ],
    app: probe,
    logger: createLogger({ level: "debug", sink: (record) => records.push(record) }),
  });
}

/** The app database, wrapped to count every statement prepared against it. */
function countingDb(): { db: D1Database; count: () => number } {
  let prepared = 0;
  const real = env.DB as unknown as D1Database;
  const db = new Proxy(real, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          prepared += 1;
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, count: () => prepared };
}

/** Ask the probe for this request's scopes. */
async function scopesOf(
  app: ReturnType<typeof buildApp>,
  token: string,
  init: { path?: string; method?: string; headers?: Record<string, string>; body?: string; db?: unknown } = {},
): Promise<{ status: number; scopes: string[] | null }> {
  const res = await app.request(
    init.path ?? "/probe",
    {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    },
    scopedWorkerEnv(env as unknown as Record<string, unknown>, init.db),
  );
  if (res.status !== 200) return { status: res.status, scopes: null };
  return { status: res.status, scopes: (await res.json<Probe>()).scopes };
}

beforeEach(async () => {
  records = [];
  await prepareScopedBackend(env);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("resolveScopes through a real auth()", () => {
  test("puts exactly what the resolver answers on c.var.auth.scopes", async () => {
    // The test that fails on `main`: the middleware wrote `scopes: []` whatever was configured.
    const { token } = await signInScoped(env.DB);
    const app = buildApp({ resolveScopes: async () => ["leaderboard:submit"] });

    expect(await scopesOf(app, token)).toEqual({ status: 200, scopes: ["leaderboard:submit"] });
  });

  test("hands the resolver the request and the session it resolved", async () => {
    const { token, userId } = await signInScoped(env.DB);
    const seen: { userId: string; sessionId: string; header: string | undefined }[] = [];
    const app = buildApp({
      resolveScopes: (c, caller) => {
        seen.push({ ...caller, header: c.req.header("x-probe") });
        return [];
      },
    });

    await scopesOf(app, token, { headers: { "x-probe": "here" } });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.userId).toBe(userId);
    expect(seen[0]?.sessionId).toEqual(expect.any(String));
    expect(seen[0]?.header).toBe("here");
  });

  test("never runs the resolver for a request with no session", async () => {
    let calls = 0;
    const app = buildApp({
      resolveScopes: () => {
        calls += 1;
        return ["leaderboard:submit"];
      },
    });

    const res = await app.request("/probe", {}, scopedWorkerEnv(env as unknown as Record<string, unknown>));

    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("with no resolver the array is empty, and the request reads D1 exactly as often as it always has", async () => {
    // Pinned to the count a plain composition prepared before the seam existed: composing auth without a
    // resolver must cost nothing new on any request.
    const { token } = await signInScoped(env.DB);
    const counted = countingDb();

    expect(await scopesOf(buildApp(), token, { db: counted.db })).toEqual({ status: 200, scopes: [] });
    expect(counted.count()).toBe(PLAIN_COMPOSITION_D1_STATEMENTS);
  });

  test("a resolver that throws leaves the array empty, logs at warn, and the request goes on", async () => {
    const { token } = await signInScoped(env.DB);
    const app = buildApp({
      resolveScopes: () => {
        throw new Error("the trusted-caller check fell over");
      },
    });

    expect(await scopesOf(app, token)).toEqual({ status: 200, scopes: [] });
    const warned = records.filter((record) => record.level === "warn");
    expect(warned.map((record) => record.msg)).toContain("resolveScopes failed; this request carries no scopes");
  });

  test("a resolver that rejects is treated exactly like one that throws", async () => {
    const { token } = await signInScoped(env.DB);
    const app = buildApp({ resolveScopes: async () => Promise.reject(new Error("no answer")) });

    expect(await scopesOf(app, token)).toEqual({ status: 200, scopes: [] });
    expect(records.some((record) => record.level === "warn")).toBe(true);
  });

  test("an answer that is not an array never reaches a guard", async () => {
    const { token } = await signInScoped(env.DB);
    const app = buildApp({ resolveScopes: (() => "leaderboard:submit") as unknown as AuthOptions["resolveScopes"] });

    expect(await scopesOf(app, token)).toEqual({ status: 200, scopes: [] });
    expect(records.filter((record) => record.level === "warn").map((record) => record.msg)).toContain(
      "resolveScopes answered something that is not a list of strings; this request carries no scopes",
    );
  });

  test("an array holding a non-string never reaches a guard — not even its string members", async () => {
    const { token } = await signInScoped(env.DB);
    const app = buildApp({
      resolveScopes: (() => ["leaderboard:submit", 7]) as unknown as AuthOptions["resolveScopes"],
    });

    expect(await scopesOf(app, token)).toEqual({ status: 200, scopes: [] });
    expect(records.some((record) => record.level === "warn")).toBe(true);
  });

  test("runs on every request and caches nothing — a changed answer takes effect on the next request", async () => {
    // A cached scope is a revocation that has not taken effect. One session, two requests, two answers.
    const { token } = await signInScoped(env.DB);
    let trusted = true;
    const app = buildApp({ resolveScopes: () => (trusted ? ["leaderboard:submit"] : []) });

    expect((await scopesOf(app, token)).scopes).toEqual(["leaderboard:submit"]);
    trusted = false;
    expect((await scopesOf(app, token)).scopes).toEqual([]);
  });

  test("no scope is ever read from what the client sends", async () => {
    // Header, body and query: the three places a client would try. With no resolver, nothing fills the array.
    const { token } = await signInScoped(env.DB);
    const app = buildApp();

    expect(
      await scopesOf(app, token, {
        path: "/probe?scope=leaderboard:submit&scopes=leaderboard:admin",
        method: "POST",
        headers: { "x-scopes": "leaderboard:submit,ledger:admin", "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["leaderboard:submit"], scope: "rating:record" }),
      }),
    ).toEqual({ status: 200, scopes: [] });
  });
});

describe("auth() with resolveScopes", () => {
  test("declares that it fills the scope seam only when a resolver is supplied", () => {
    expect(auth({ baseURL: SCOPED_ORIGIN }).providesScopes).toBe(false);
    expect(auth({ baseURL: SCOPED_ORIGIN, resolveScopes: () => [] }).providesScopes).toBe(true);
  });

  test("keeps the resolver out of the parsed config and out of the client projection", () => {
    const capability = auth({ baseURL: SCOPED_ORIGIN, resolveScopes: () => [] });
    expect("resolveScopes" in capability.authConfig).toBe(false);
    const projection = capability.client?.({ environment: "dev" }) ?? {};
    const functions = JSON.stringify(projection, (_key, value: unknown) =>
      typeof value === "function" ? "<function>" : value,
    );
    expect(functions).not.toContain("<function>");
    expect(Object.values(projection).some((value) => typeof value === "function")).toBe(false);
  });
});

/**
 * How many statements one authenticated request through a plain `auth()` prepares against `DB` — Better
 * Auth's session lookup and what it writes back. Measured on `main` before `resolveScopes` existed, so a
 * resolver that is not configured provably adds no read.
 */
const PLAIN_COMPOSITION_D1_STATEMENTS = 5;
