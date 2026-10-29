// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AuthFetch, getSession, sendOtp, signInWithOtp } from "../client/api";
import {
  BEARER_DEVICE_HEADERS,
  type BearerSession,
  createBearerSession,
  type DeviceInfo,
  ROTATION_MARGIN_MS,
  type SecureStore,
} from "../client/bearer";
import { DEVICE_HEADERS } from "../device/registry";
import { type LiveApp, resetLiveSecrets, startLiveApp } from "../test-utils/liveApp";

/**
 * The bearer session against the real routes, on a real port, the way a native app reaches them.
 *
 * `bearer.test.ts` proves the order of things against a script. This proves the Worker agrees: that the
 * raw token a sign-in answers with authenticates, that `/token/rotate` takes it and hands back one that
 * does, that a spent credential presented late revokes everything descended from the sign-in, and that
 * two requests made once the credential is due spend it exactly once.
 *
 * **The fetch below behaves like a native app's**: absolute URLs, no cookie jar and no `Origin`. A
 * request that carried a cookie with no `Origin` would be refused by Better Auth's own origin check,
 * which is what the session's `credentials: "omit"` exists to prevent.
 */

const BASE_PATH = "/auth";

/** A fetch with no cookie jar, logging every URL it was asked for. */
function nativeLike(log: string[]): AuthFetch {
  return async (url, init) => {
    log.push(url);
    return fetch(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body });
  };
}

/** A secure store backed by a map. */
function memoryStore(): SecureStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    deleteItem: async (key) => {
      data.delete(key);
    },
  };
}

let app: LiveApp;

beforeAll(async () => {
  app = await startLiveApp({ basePath: BASE_PATH });
});

afterAll(async () => {
  await app?.close();
  resetLiveSecrets();
});

/** A session signed in by one-time code over bearer, and what it was signed in as. */
async function signedIn(
  email: string,
  device: DeviceInfo,
  now?: () => number,
): Promise<{ session: BearerSession; log: string[]; store: ReturnType<typeof memoryStore> }> {
  const log: string[] = [];
  const store = memoryStore();
  const session = createBearerSession({
    origin: app.origin,
    basePath: BASE_PATH,
    store,
    device,
    fetch: nativeLike(log),
    ...(now ? { now } : {}),
  });
  // Better Auth limits code sends per address and per client; every test here is one fresh reader.
  await app.db.prepare("delete from pithy_auth_rate_limit").run();
  const sent = await sendOtp({ email, type: "sign-in" }, session.options);
  expect(sent).toEqual({ ok: true, value: expect.anything() });
  const otp = await app.mailedOtp(email);
  expect(otp).not.toBeNull();
  const answer = await signInWithOtp({ email, otp: otp ?? "" }, session.options);
  expect(answer.ok).toBe(true);
  const token = answer.ok ? answer.value.token : undefined;
  expect(typeof token).toBe("string");
  await session.adopt(token as string);
  return { session, log, store };
}

/** Present a credential to a kit route that requires one, and answer with the status. */
async function statusWith(token: string): Promise<number> {
  const response = await fetch(`${app.origin}${BASE_PATH}/devices`, { headers: { authorization: `Bearer ${token}` } });
  return response.status;
}

/** The raw token a session currently holds, read out of its store. */
function heldToken(store: ReturnType<typeof memoryStore>): string {
  const [value] = [...store.data.values()];
  return (JSON.parse(value ?? "{}") as { token: string }).token;
}

/** How many sessions a user has. */
async function liveSessions(email: string): Promise<number> {
  const row = await app.db
    .prepare(
      "select count(*) as n from pithy_auth_sessions s join pithy_auth_users u on u.id = s.user_id where u.email = ?",
    )
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("the device headers the session sends are the ones the Worker reads", () => {
  test("each name matches the server's", () => {
    expect(BEARER_DEVICE_HEADERS).toEqual({
      id: DEVICE_HEADERS.id,
      platform: DEVICE_HEADERS.platform,
      name: DEVICE_HEADERS.name,
      model: DEVICE_HEADERS.model,
    });
  });
});

describe("a bearer session, against the routes it names", () => {
  test("a one-time code signs in, the device is registered, and the raw token authenticates", async () => {
    const email = "bearer-sign-in@example.test";
    const { session, store } = await signedIn(email, {
      id: "live-device-1",
      platform: "ios",
      name: "Test Phone",
      model: "iPhone17,1",
    });
    const answer = await getSession(session.options);
    expect(answer.ok && answer.value?.user.email).toBe(email);

    const device = await app.db
      .prepare("select platform, name, model from pithy_auth_devices where id = ?")
      .bind("live-device-1")
      .first<{ platform: string; name: string; model: string }>();
    expect(device).toEqual({ platform: "ios", name: "Test Phone", model: "iPhone17,1" });
    expect(await statusWith(heldToken(store))).toBe(200);
  });

  test("a rotation succeeds, the successor authenticates, and the spent credential is refused", async () => {
    const { session, store } = await signedIn("bearer-rotate@example.test", {
      id: "live-device-2",
      platform: "android",
    });
    const spent = heldToken(store);
    const rotated = await session.rotate();
    expect(rotated.ok).toBe(true);
    const successor = heldToken(store);
    expect(successor).not.toBe(spent);

    expect(await statusWith(spent)).toBe(401);
    expect(await statusWith(successor)).toBe(200);
    const answer = await getSession(session.options);
    expect(answer.ok && answer.value?.user.email).toBe("bearer-rotate@example.test");
  });

  test("a spent credential replayed past the grace window revokes the family, and the session finds itself signed out", async () => {
    const email = "bearer-replay@example.test";
    const { session, store } = await signedIn(email, { id: "live-device-3", platform: "ios" });
    const spent = heldToken(store);
    expect((await session.rotate()).ok).toBe(true);

    // Put the ledger entry where thirty-odd seconds would have put it.
    await app.db
      .prepare("update pithy_auth_rotated_tokens set rotated_at = ? where token = ?")
      .bind(1_000, spent)
      .run();

    // Another holder of the spent credential — a restored backup, a thief — presents it.
    const thief = createBearerSession({
      origin: app.origin,
      basePath: BASE_PATH,
      store: memoryStore(),
      device: { id: "elsewhere", platform: "android" },
      fetch: nativeLike([]),
    });
    await thief.adopt(spent);
    const replay = await thief.rotate();
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.failure.code).toBe("auth/invalid_token");
    expect(thief.signedIn()).toBe(false);

    expect(await liveSessions(email)).toBe(0);
    expect(app.events.some((event) => event.action === "auth/token_reuse_detected")).toBe(true);

    // The legitimate session's successor went with the family.
    expect(await getSession(session.options)).toEqual({ ok: true, value: null });
    expect(session.signedIn()).toBe(false);
    expect(store.data.size).toBe(0);
  });

  test("two requests made once the credential is due produce exactly one rotation, and both succeed", async () => {
    const email = "bearer-concurrent@example.test";
    let current = Date.now();
    const { session, log } = await signedIn(email, { id: "live-device-4", platform: "ios" }, () => current);

    // The expiry is learnt from the session the Worker describes.
    const first = await getSession(session.options);
    expect(first.ok && first.value?.user.email).toBe(email);
    const described = await app.db
      .prepare(
        "select s.expires_at as e from pithy_auth_sessions s join pithy_auth_users u on u.id = s.user_id where u.email = ?",
      )
      .bind(email)
      .first<{ e: string | number }>();
    const expiresAt = typeof described?.e === "number" ? described.e : Date.parse(String(described?.e));
    expect(Number.isFinite(expiresAt)).toBe(true);

    current = expiresAt - ROTATION_MARGIN_MS + 1;
    log.length = 0;
    const [a, b] = await Promise.all([getSession(session.options), getSession(session.options)]);
    expect(a.ok && a.value?.user.email).toBe(email);
    expect(b.ok && b.value?.user.email).toBe(email);
    expect(log.filter((url) => url.endsWith(`${BASE_PATH}/token/rotate`))).toHaveLength(1);
    expect(await liveSessions(email)).toBe(1);
  });
});
