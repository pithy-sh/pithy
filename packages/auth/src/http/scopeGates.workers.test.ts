// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { email } from "@pithy-sh/email/src/capability";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { ledger } from "@pithy-sh/ledger/src/capability";
import { rating } from "@pithy-sh/rating/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CALLER_TOKEN_SECRET, callerTokenRegistry, verifyCallerRequest } from "../caller/request";
import { CALLER_TOKEN_HEADER, mintCallerToken } from "../caller/token";
import { auth } from "../capability";
import {
  type ExtraMigrations,
  prepareScopedBackend,
  SCOPED_ORIGIN,
  SCOPED_REGISTRY,
  scopedWorkerEnv,
  signInScoped,
} from "../test-utils/scopedBackend";

/**
 * **The four scope gates, opened by a real caller through a real `auth()` — and shut for everyone else
 * (#560).**
 *
 * `leaderboard:submit`, `leaderboard:admin`, `rating:record` and `ledger:admin` refused every caller from
 * the day they shipped, because nothing filled `AuthContext.scopes`; each passed its own suite against a
 * stub that filled it by hand. Every capability here is the real one on its defaults, composed through
 * `createBackend`, and the resolver is the one the docs recommend: a short-lived caller token, verified
 * against a key read from the secrets store, minted for this origin.
 *
 * The same request, from the same signed-in session, is made twice — once with the token and once
 * without. That is the whole distinction the gates draw: not who the user is, but whether this write came
 * from the adopter's own backend.
 *
 * **The session is the player's, forwarded by the backend.** A score is filed under the session's user, so
 * a backend that called with a session of its own would rank itself. The backend relays the player's
 * session on `Authorization` and adds its own proof on {@link CALLER_TOKEN_HEADER} beside it.
 */

const CALLER_KEY = "caller-token-key-for-the-gate-suite-0000";

/** Every scope the resolver attests to for a verified caller. */
const TRUSTED_SCOPES = ["leaderboard:submit", "leaderboard:admin", "rating:record", "ledger:admin"];

/** The three gated capabilities, on their defaults — the composition #560 says could not work. */
function gated(): Capability[] {
  return [
    leaderboard({ boards: [{ key: "b1", direction: "desc" }] }),
    rating({ games: [{ key: "ranked", algorithm: "elo" }] }),
    ledger({ currencies: [{ code: "chips", name: "Chips" }] }),
  ];
}

/** Their migrations, read off the capabilities themselves so the suite cannot drift from what they ship. */
function gatedMigrations(): ExtraMigrations[] {
  return gated().flatMap((capability) =>
    Object.values(capability.databases ?? {}).map((spec) => ({
      namespace: capability.name,
      order: spec.migrationOrder ?? 0,
      migrations: spec.migrations ?? {},
    })),
  );
}

/** One backend: secrets, email, auth with a caller-token resolver, and the three gated capabilities. */
function buildApp(withResolver = true) {
  return createBackend({
    capabilities: [
      secrets({ registry: { ...SCOPED_REGISTRY, ...callerTokenRegistry } }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: SCOPED_ORIGIN }),
      auth({
        baseURL: SCOPED_ORIGIN,
        basePath: "/auth",
        trustedOrigins: [SCOPED_ORIGIN],
        ...(withResolver
          ? {
              resolveScopes: async (c) =>
                (await verifyCallerRequest(c, { audience: SCOPED_ORIGIN })).trusted ? TRUSTED_SCOPES : [],
            }
          : {}),
      }),
      ...gated(),
    ],
  });
}

/** A caller token the trusted backend would mint right now. */
function callerToken(): Promise<string> {
  return mintCallerToken({ key: CALLER_KEY, kid: "1", audience: SCOPED_ORIGIN, subject: "game-server" });
}

let session: { token: string; userId: string };

/** Make one request as the signed-in session, with or without the caller token beside it. */
async function call(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
  body: unknown,
  caller: string | null,
): Promise<{ status: number; code: string | null }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.token}`,
    "content-type": "application/json",
  };
  if (caller !== null) headers[CALLER_TOKEN_HEADER] = caller;
  const res = await app.request(
    path,
    { method, headers, body: JSON.stringify(body) },
    scopedWorkerEnv(env as unknown as Record<string, unknown>),
  );
  const answer = res.status >= 400 ? await res.json<{ error?: { code?: string } }>() : null;
  return { status: res.status, code: answer?.error?.code ?? null };
}

beforeEach(async () => {
  await prepareScopedBackend(env, gatedMigrations());
  await seedSecrets(env, callerTokenRegistry, { [CALLER_TOKEN_SECRET]: CALLER_KEY });
  // The player whose session the trusted backend forwards. Not the backend's own account.
  session = await signInScoped(env.DB, "player@example.com");
});

afterEach(() => {
  resetSharedSecrets();
});

describe("leaderboard:submit", () => {
  test("a caller resolving the scope posts a score; the same session without it is refused", async () => {
    const app = buildApp();
    expect(await call(app, "POST", "/leaderboard/b1", { score: 10 }, await callerToken())).toEqual({
      status: 201,
      code: null,
    });
    expect(await call(app, "POST", "/leaderboard/b1", { score: 99 }, null)).toEqual({
      status: 403,
      code: "leaderboard/submit_forbidden",
    });
  });

  test("the score is filed under the player whose session the backend forwarded", async () => {
    // The body names no player. The board credits the session's user, which is why the backend forwards
    // the player's session rather than holding one of its own.
    const app = buildApp();
    expect((await call(app, "POST", "/leaderboard/b1", { score: 10 }, await callerToken())).status).toBe(201);
    const res = await app.request(
      "/leaderboard/b1/top",
      { headers: { authorization: `Bearer ${session.token}` } },
      scopedWorkerEnv(env as unknown as Record<string, unknown>),
    );
    const page = await res.json<{ entries: { userId: string; score: number }[] }>();
    expect(page.entries.map(({ userId, score }) => ({ userId, score }))).toEqual([
      { userId: session.userId, score: 10 },
    ]);
  });
});

describe("leaderboard:admin", () => {
  test("a caller resolving the scope hides an entry; the same session without it is refused", async () => {
    const app = buildApp();
    expect((await call(app, "POST", "/leaderboard/b1", { score: 10 }, await callerToken())).status).toBe(201);
    const path = `/leaderboard/b1/entries/${session.userId}/hidden`;

    expect(await call(app, "PUT", path, { hidden: true }, null)).toEqual({ status: 403, code: "auth/forbidden" });
    expect(await call(app, "PUT", path, { hidden: true }, await callerToken())).toEqual({ status: 200, code: null });
  });
});

describe("rating:record", () => {
  test("a caller resolving the scope records an outcome; the same session without it is refused", async () => {
    const app = buildApp();
    const outcome = { ranks: { "player-a": 1, "player-b": 2 } };
    expect(await call(app, "POST", "/rating/games/ranked/outcomes", outcome, await callerToken())).toEqual({
      status: 201,
      code: null,
    });
    expect(await call(app, "POST", "/rating/games/ranked/outcomes", outcome, null)).toEqual({
      status: 403,
      code: "rating/record_forbidden",
    });
  });
});

describe("ledger:admin", () => {
  test("a caller resolving the scope credits a balance; the same session without it is refused", async () => {
    const app = buildApp();
    const credit = { userId: "player-a", amount: 100, ref: "grant-1" };
    expect(await call(app, "POST", "/ledger/chips/credit", credit, await callerToken())).toEqual({
      status: 200,
      code: null,
    });
    expect(await call(app, "POST", "/ledger/chips/debit", { ...credit, ref: "take-1" }, null)).toEqual({
      status: 403,
      code: "auth/forbidden",
    });
  });
});

describe("with no resolver composed", () => {
  test("every gate refuses even a caller holding a valid token — nothing reads it", async () => {
    // The state every project was in before #560, and the state `pithy doctor` now names.
    const app = buildApp(false);
    const token = await callerToken();
    const statuses = [
      (await call(app, "POST", "/leaderboard/b1", { score: 1 }, token)).status,
      (await call(app, "PUT", `/leaderboard/b1/entries/${session.userId}/hidden`, { hidden: true }, token)).status,
      (await call(app, "POST", "/rating/games/ranked/outcomes", { ranks: { a: 1, b: 2 } }, token)).status,
      (await call(app, "POST", "/ledger/chips/credit", { userId: "a", amount: 1, ref: "r" }, token)).status,
    ];
    expect(statuses).toEqual([403, 403, 403, 403]);
  });
});

describe("a token that is not good enough", () => {
  test("one minted for another origin opens nothing", async () => {
    const app = buildApp();
    const elsewhere = await mintCallerToken({ key: CALLER_KEY, kid: "1", audience: "https://staging.example.com" });
    expect((await call(app, "POST", "/leaderboard/b1", { score: 1 }, elsewhere)).status).toBe(403);
  });

  test("one signed with another key opens nothing", async () => {
    const app = buildApp();
    const forged = await mintCallerToken({ key: "not-the-stored-key", kid: "1", audience: SCOPED_ORIGIN });
    expect((await call(app, "POST", "/ledger/chips/credit", { userId: "a", amount: 1, ref: "r" }, forged)).status).toBe(
      403,
    );
  });
});
