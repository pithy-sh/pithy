// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { AUTH_CROSS_ORIGIN, type AuthFetch, type AuthRequestInit, getSession, signInWithOtp, signOut } from "./api";
import {
  BEARER_DEVICE_HEADERS,
  BEARER_STORAGE_KEY,
  createBearerSession,
  type DeviceInfo,
  ROTATION_MARGIN_MS,
  type SecureStore,
} from "./bearer";

/**
 * The bearer session, driven through its seams: a store that records every write, a fetch that answers
 * from a script, and a clock the test moves.
 *
 * What is pinned here is the order of things, because the order is the whole of what makes rotation
 * safe. A successor that is in use before it is stored is a credential a restart forgets, and the next
 * launch presents the spent one — which the Worker reads as theft and answers by revoking every session
 * descended from that sign-in.
 */

const ORIGIN = "https://api.example.test";

const DEVICE: DeviceInfo = { id: "device-1", platform: "ios", name: "Test Phone", model: "iPhone17,1" };

/** One thing that happened, in the order it happened: a request sent, or a store operation. */
type Step =
  | { kind: "request"; url: string; init: AuthRequestInit | undefined }
  | { kind: "set"; key: string; value: string }
  | { kind: "delete"; key: string };

/** A secure store backed by a map, writing every operation into the shared log. */
function memoryStore(log: Step[], initial: Record<string, string> = {}): SecureStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      log.push({ kind: "set", key, value });
      data.set(key, value);
    },
    deleteItem: async (key) => {
      log.push({ kind: "delete", key });
      data.delete(key);
    },
  };
}

/** An answer a scripted route gives: a status and a body. */
interface Answer {
  status: number;
  body: unknown;
}

/** A fetch that logs every request and answers by path, with an optional gate a test opens by hand. */
function scripted(
  log: Step[],
  routes: Record<string, (init: AuthRequestInit | undefined) => Answer | Promise<Answer>>,
): AuthFetch {
  return async (url, init) => {
    log.push({ kind: "request", url, init });
    const path = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
    const route = routes[path];
    const answer = route ? await route(init) : { status: 404, body: { error: { code: "x", message: "none" } } };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    };
  };
}

/** The credential a request carried, or null. */
function bearerOf(step: Step | undefined): string | null {
  if (step?.kind !== "request") return null;
  const value = step.init?.headers?.authorization;
  return value === undefined ? null : value.replace(/^Bearer /, "");
}

/** The requests in a log, in order. */
function requests(log: Step[]): Extract<Step, { kind: "request" }>[] {
  return log.filter((step): step is Extract<Step, { kind: "request" }> => step.kind === "request");
}

/** A clock a test advances. */
function clock(start = Date.parse("2026-01-01T00:00:00Z")): { now: () => number; set: (ms: number) => void } {
  let current = start;
  return { now: () => current, set: (ms) => (current = ms) };
}

/** A rotation answer minting `token`, expiring at `expiresAt`. */
function rotated(token: string, expiresAt: number): Answer {
  return {
    status: 200,
    body: {
      accessToken: "header.payload.signature",
      refreshToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    },
  };
}

describe("the transport a bearer session puts on every request", () => {
  test("the options carry the origin, the base path and the session's own fetch", () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      basePath: "/identity",
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    expect(session.options).toEqual({ origin: ORIGIN, basePath: "/identity", fetch: session.fetch });
    expect(createBearerSession({ origin: ORIGIN, store: memoryStore(log), device: DEVICE }).options.basePath).toBe(
      "/auth",
    );
  });

  test("a held credential rides as `Authorization`, and no request ever carries a cookie", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, { "/auth/get-session": () => ({ status: 200, body: null }) }),
    });
    await getSession(session.options);
    await session.adopt("raw-token-1");
    await signOut(session.options);

    const sent = requests(log);
    expect(sent.map((step) => step.url)).toEqual([`${ORIGIN}/auth/get-session`, `${ORIGIN}/auth/sign-out`]);
    expect(bearerOf(sent[0])).toBeNull();
    expect(bearerOf(sent[1])).toBe("raw-token-1");
    for (const step of sent) {
      expect(step.init?.credentials).toBe("omit");
      expect(Object.keys(step.init?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("cookie");
    }
  });

  test("a caller's own `Authorization` never displaces the session's credential", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    await session.adopt("raw-token-1");
    await session.fetch(`${ORIGIN}/orgs/organizations`, { headers: { Authorization: "Bearer someone-else" } });
    const headers = requests(log)[0]?.init?.headers ?? {};
    expect(Object.entries(headers).filter(([name]) => name.toLowerCase() === "authorization")).toEqual([
      ["authorization", "Bearer raw-token-1"],
    ]);
  });

  test("an origin that is not a bare http(s) origin refuses before anything is sent", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: "https://api.example.test/v1",
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    expect(await getSession(session.options)).toEqual({ ok: false, failure: AUTH_CROSS_ORIGIN });
    expect(log).toEqual([]);
  });
});

describe("the device a sign-in registers", () => {
  test("a sign-in carries the device id, platform, name and model, under the headers the Worker reads", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, { "/auth/sign-in/email-otp": () => ({ status: 200, body: { token: "t", user: {} } }) }),
    });
    await signInWithOtp({ email: "a@example.test", otp: "123456" }, session.options);
    const headers = requests(log)[0]?.init?.headers ?? {};
    expect(headers).toMatchObject({
      "content-type": "application/json",
      [BEARER_DEVICE_HEADERS.id]: "device-1",
      [BEARER_DEVICE_HEADERS.platform]: "ios",
      [BEARER_DEVICE_HEADERS.name]: "Test Phone",
      [BEARER_DEVICE_HEADERS.model]: "iPhone17,1",
    });
  });

  test("the optional fields are left off when the app does not know them", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: { id: "device-2", platform: "android" },
      fetch: scripted(log, {}),
    });
    await signInWithOtp({ email: "a@example.test", otp: "123456" }, session.options);
    const headers = requests(log)[0]?.init?.headers ?? {};
    expect(headers[BEARER_DEVICE_HEADERS.id]).toBe("device-2");
    expect(headers[BEARER_DEVICE_HEADERS.platform]).toBe("android");
    expect(BEARER_DEVICE_HEADERS.name in headers).toBe(false);
    expect(BEARER_DEVICE_HEADERS.model in headers).toBe(false);
  });

  test("a name a header cannot carry is cleaned rather than failing the sign-in", async () => {
    // `fetch` refuses a header value outside Latin-1, so a phone named with a curly apostrophe would
    // otherwise make every sign-in from it read as offline.
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: { id: "device-3", platform: "ios", name: "Jim’s iPhone \u{1F4F1}", model: "   " },
      fetch: scripted(log, {}),
    });
    await signInWithOtp({ email: "a@example.test", otp: "123456" }, session.options);
    const headers = requests(log)[0]?.init?.headers ?? {};
    expect(headers[BEARER_DEVICE_HEADERS.name]).toBe("Jims iPhone");
    expect(BEARER_DEVICE_HEADERS.model in headers).toBe(false);
  });

  test("an id the Worker would refuse to store sends no device at all, so the sign-in still succeeds", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: { id: "x".repeat(129), platform: "ios", name: "Phone" },
      fetch: scripted(log, {}),
    });
    await signInWithOtp({ email: "a@example.test", otp: "123456" }, session.options);
    const names = Object.keys(requests(log)[0]?.init?.headers ?? {});
    expect(names.filter((name) => name.startsWith("x-pithy-"))).toEqual([]);
  });

  test("the device rides only on the auth routes, not on another capability's", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    await session.fetch(`${ORIGIN}/orgs/organizations`);
    const names = Object.keys(requests(log)[0]?.init?.headers ?? {});
    expect(names.filter((name) => name.startsWith("x-pithy-"))).toEqual([]);
  });
});

describe("the device on another capability's routes", () => {
  test("is never named: the registered device id is listed to operators, so it goes to auth alone", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    await session.fetch(`${ORIGIN}/consent/me`);
    await session.fetch(`${ORIGIN}/orgs/organizations`);
    for (const step of requests(log)) {
      expect(
        Object.keys(step.init?.headers ?? {}).filter((name) => name.startsWith("x-pithy-")),
        step.url,
      ).toEqual([]);
    }
  });
});

describe("holding and restoring the credential", () => {
  test("adopt stores the token before it resolves, under the storage key, and nowhere else", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    const session = createBearerSession({ origin: ORIGIN, store, device: DEVICE, fetch: scripted(log, {}) });
    expect(session.signedIn()).toBe(false);
    const adopting = session.adopt("raw-token-1");
    await adopting;
    expect(log).toEqual([{ kind: "set", key: BEARER_STORAGE_KEY, value: expect.stringContaining("raw-token-1") }]);
    expect(session.signedIn()).toBe(true);
  });

  test("restore loads what an earlier launch stored, and the next request carries it", async () => {
    const log: Step[] = [];
    const first = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    await first.adopt("raw-token-1");
    const stored = Object.fromEntries(
      (log.filter((step) => step.kind === "set") as { key: string; value: string }[]).map((s) => [s.key, s.value]),
    );

    const later: Step[] = [];
    const second = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(later, stored),
      device: DEVICE,
      fetch: scripted(later, {}),
    });
    expect(second.signedIn()).toBe(false);
    expect(await second.restore()).toBe(true);
    expect(second.signedIn()).toBe(true);
    await signOut(second.options);
    expect(bearerOf(requests(later)[0])).toBe("raw-token-1");
  });

  test("restore with nothing stored is false, and a stored value it cannot read is removed", async () => {
    const log: Step[] = [];
    expect(
      await createBearerSession({
        origin: ORIGIN,
        store: memoryStore(log),
        device: DEVICE,
        fetch: scripted(log, {}),
      }).restore(),
    ).toBe(false);

    const garbled = memoryStore(log, { [BEARER_STORAGE_KEY]: "{not json" });
    const session = createBearerSession({ origin: ORIGIN, store: garbled, device: DEVICE, fetch: scripted(log, {}) });
    expect(await session.restore()).toBe(false);
    expect(session.signedIn()).toBe(false);
    expect(garbled.data.has(BEARER_STORAGE_KEY)).toBe(false);
  });

  test("a store that throws costs persistence, never a crash", async () => {
    const log: Step[] = [];
    const broken: SecureStore = {
      getItem: async () => {
        throw new TypeError("keychain locked");
      },
      setItem: async () => {
        throw new TypeError("keychain locked");
      },
      deleteItem: async () => {
        throw new TypeError("keychain locked");
      },
    };
    const session = createBearerSession({ origin: ORIGIN, store: broken, device: DEVICE, fetch: scripted(log, {}) });
    expect(await session.restore()).toBe(false);
    await session.adopt("raw-token-1");
    expect(session.signedIn()).toBe(true);
    await session.clear();
    expect(session.signedIn()).toBe(false);
  });

  test("clear forgets the credential in memory and in the store", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    const session = createBearerSession({ origin: ORIGIN, store, device: DEVICE, fetch: scripted(log, {}) });
    await session.adopt("raw-token-1");
    await session.clear();
    expect(session.signedIn()).toBe(false);
    expect(store.data.has(BEARER_STORAGE_KEY)).toBe(false);
    await signOut(session.options);
    expect(bearerOf(requests(log)[0])).toBeNull();
  });

  test("a session the Worker answers as nobody is a credential that is dead, and it is forgotten", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    const session = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      fetch: scripted(log, { "/auth/get-session": () => ({ status: 200, body: null }) }),
    });
    await session.adopt("revoked-token");
    expect(await getSession(session.options)).toEqual({ ok: true, value: null });
    expect(session.signedIn()).toBe(false);
    expect(store.data.has(BEARER_STORAGE_KEY)).toBe(false);
  });
});

describe("rotation", () => {
  test("rotate trades the held credential for its successor, stores it, and reports the new expiry", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    const expiry = Date.parse("2026-01-08T00:00:00Z");
    const session = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      fetch: scripted(log, { "/auth/token/rotate": () => rotated("raw-token-2", expiry) }),
    });
    await session.adopt("raw-token-1");
    const result = await session.rotate();
    expect(result).toEqual({ ok: true, value: { expiresAt: new Date(expiry).toISOString() } });

    const sent = requests(log);
    expect(sent[0]?.url).toBe(`${ORIGIN}/auth/token/rotate`);
    expect(sent[0]?.init?.method).toBe("POST");
    expect(bearerOf(sent[0])).toBe("raw-token-1");
    expect(store.data.get(BEARER_STORAGE_KEY)).toContain("raw-token-2");
    // Never the JWT: it does not authenticate the kit's routes.
    expect(store.data.get(BEARER_STORAGE_KEY)).not.toContain("header.payload.signature");
  });

  test("two rotations asked for at once are one request", async () => {
    const log: Step[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {
        "/auth/token/rotate": async () => {
          await gate;
          return rotated("raw-token-2", Date.parse("2026-01-08T00:00:00Z"));
        },
      }),
    });
    await session.adopt("raw-token-1");
    const both = Promise.all([session.rotate(), session.rotate()]);
    release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(requests(log).filter((step) => step.url.endsWith("/token/rotate"))).toHaveLength(1);
  });

  test("two requests made once the credential is due produce exactly one rotation, and both wait for its successor", async () => {
    const log: Step[] = [];
    const time = clock();
    const firstExpiry = time.now() + 7 * 24 * 3600_000;
    let rotations = 0;
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      now: time.now,
      fetch: scripted(log, {
        "/auth/token/rotate": () => {
          rotations += 1;
          return rotated(`raw-token-${rotations + 1}`, time.now() + 7 * 24 * 3600_000);
        },
        "/auth/get-session": () => ({
          status: 200,
          body: {
            session: { expiresAt: new Date(firstExpiry).toISOString() },
            user: { id: "u", email: "a@example.test" },
          },
        }),
      }),
    });
    await session.adopt("raw-token-1");
    // The expiry is learnt from the session the Worker describes.
    await getSession(session.options);
    log.length = 0;

    // Not yet due: no rotation.
    time.set(firstExpiry - ROTATION_MARGIN_MS - 1);
    await signOut(session.options);
    expect(rotations).toBe(0);
    log.length = 0;

    // Due: two requests at once, one rotation, and the successor is stored before either request leaves.
    time.set(firstExpiry - ROTATION_MARGIN_MS + 1);
    await Promise.all([signOut(session.options), session.fetch(`${ORIGIN}/orgs/organizations`)]);
    expect(rotations).toBe(1);
    const rotateAt = log.findIndex((step) => step.kind === "request" && step.url.endsWith("/token/rotate"));
    const storedAt = log.findIndex((step) => step.kind === "set" && step.value.includes("raw-token-2"));
    const others = log
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.kind === "request" && !step.url.endsWith("/token/rotate"));
    expect(rotateAt).toBeGreaterThanOrEqual(0);
    expect(storedAt).toBeGreaterThan(rotateAt);
    expect(others).toHaveLength(2);
    for (const { step, index } of others) {
      expect(index).toBeGreaterThan(storedAt);
      expect(bearerOf(step)).toBe("raw-token-2");
    }
  });

  test("a credential the Worker refuses to rotate is signed out, and the refusal is reported", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    const session = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      fetch: scripted(log, {
        "/auth/token/rotate": () => ({
          status: 401,
          body: { error: { code: "auth/invalid_token", message: "This credential has been revoked." } },
        }),
      }),
    });
    await session.adopt("raw-token-1");
    const result = await session.rotate();
    expect(result).toEqual({
      ok: false,
      failure: { code: "auth/invalid_token", message: "This credential has been revoked.", action: null },
    });
    expect(session.signedIn()).toBe(false);
    expect(store.data.has(BEARER_STORAGE_KEY)).toBe(false);
  });

  test("a rotation that never reached the Worker keeps the credential, because nothing was spent", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    await session.adopt("raw-token-1");
    const result = await session.rotate();
    expect(result.ok).toBe(false);
    expect(session.signedIn()).toBe(true);
  });

  test("a successor that cannot be stored removes the spent credential from the store rather than leaving it", async () => {
    // The next launch would present the spent token, and past the grace window that revokes the family.
    const log: Step[] = [];
    const data = new Map<string, string>();
    let writes = 0;
    const store: SecureStore = {
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => {
        writes += 1;
        if (writes > 1) throw new TypeError("keychain full");
        data.set(key, value);
      },
      deleteItem: async (key) => {
        data.delete(key);
      },
    };
    const session = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      fetch: scripted(log, { "/auth/token/rotate": () => rotated("raw-token-2", Date.parse("2026-01-08T00:00:00Z")) }),
    });
    await session.adopt("raw-token-1");
    expect((await session.rotate()).ok).toBe(true);
    expect(data.has(BEARER_STORAGE_KEY)).toBe(false);
    expect(session.signedIn()).toBe(true);
  });

  test("a restored credential keeps the expiry it was stored with, so a relaunch past it rotates first", async () => {
    const log: Step[] = [];
    const time = clock();
    const expiry = time.now() + 3600_000;
    const store = memoryStore(log);
    const first = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      now: time.now,
      fetch: scripted(log, { "/auth/token/rotate": () => rotated("raw-token-2", expiry) }),
    });
    await first.adopt("raw-token-1");
    await first.rotate();

    const later: Step[] = [];
    time.set(expiry - ROTATION_MARGIN_MS + 1);
    const second = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(later, Object.fromEntries(store.data)),
      device: DEVICE,
      now: time.now,
      fetch: scripted(later, { "/auth/token/rotate": () => rotated("raw-token-3", time.now() + 3600_000) }),
    });
    await second.restore();
    await signOut(second.options);
    const sent = requests(later);
    expect(sent.map((step) => step.url)).toEqual([`${ORIGIN}/auth/token/rotate`, `${ORIGIN}/auth/sign-out`]);
    expect(bearerOf(sent[0])).toBe("raw-token-2");
    expect(bearerOf(sent[1])).toBe("raw-token-3");
  });

  test("a sign-in adopted while a rotation is in flight is not overwritten by that rotation's successor", async () => {
    const log: Step[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {
        "/auth/token/rotate": async () => {
          await gate;
          return rotated("stale-successor", Date.parse("2026-01-08T00:00:00Z"));
        },
      }),
    });
    await session.adopt("raw-token-1");
    const rotating = session.rotate();
    await session.adopt("fresh-sign-in");
    release();
    await rotating;
    log.length = 0;
    await signOut(session.options);
    expect(bearerOf(requests(log)[0])).toBe("fresh-sign-in");
  });
});

describe("a restore that overlaps a rotation", () => {
  test("never puts back the credential the rotation spent", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const gatedStore: SecureStore = {
      ...store,
      getItem: async (key) => {
        const value = await store.getItem(key);
        await readGate;
        return value;
      },
    };
    const session = createBearerSession({
      origin: ORIGIN,
      store: gatedStore,
      device: DEVICE,
      fetch: scripted(log, {
        "/auth/token/rotate": () => rotated("raw-token-2", Date.parse("2026-01-08T00:00:00Z")),
      }),
    });
    await session.adopt("raw-token-1");
    // A second restore (an app returning to the foreground, an effect run twice) reads the store before the
    // rotation below has written its successor, and answers after.
    const restoring = session.restore();
    expect((await session.rotate()).ok).toBe(true);
    releaseRead();
    expect(await restoring).toBe(true);

    log.length = 0;
    await signOut(session.options);
    expect(bearerOf(requests(log)[0])).toBe("raw-token-2");
  });
});

describe("what a session's credential is never spent on", () => {
  test("an origin that is not a bare http(s) origin never has the credential sent to it, by any caller", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: `${ORIGIN}@elsewhere.example`,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    await session.adopt("raw-token-1");
    // Another capability's client composes its URLs on the configured origin and hands them to this fetch.
    await expect(session.fetch(`${ORIGIN}@elsewhere.example/payments/checkout`)).rejects.toThrow(TypeError);
    expect(requests(log)).toEqual([]);
  });

  test("a request to anywhere but the session's own origin is refused, and the credential never leaves", async () => {
    const log: Step[] = [];
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      fetch: scripted(log, {}),
    });
    await session.adopt("raw-token-1");
    for (const url of [
      "https://elsewhere.example/auth/get-session",
      `${ORIGIN}.elsewhere.example/auth/get-session`,
      `${ORIGIN}@elsewhere.example/auth/get-session`,
      "/auth/get-session",
    ]) {
      await expect(session.fetch(url)).rejects.toThrow(TypeError);
    }
    expect(requests(log)).toEqual([]);
  });

  test("a `get-session` answered for a credential a rotation has since replaced does not sign the successor out", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const session = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      fetch: scripted(log, {
        "/auth/get-session": async () => {
          await gate;
          // The presented credential was spent by the rotation below, so the Worker knows no session.
          return { status: 200, body: null };
        },
        "/auth/token/rotate": () => rotated("raw-token-2", Date.parse("2026-01-08T00:00:00Z")),
      }),
    });
    await session.adopt("raw-token-1");
    const reading = getSession(session.options);
    // Let the read leave under the first credential before the rotation replaces it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await session.rotate()).toMatchObject({ ok: true });
    release();
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.signedIn()).toBe(true);
    expect(store.data.get(BEARER_STORAGE_KEY)).toContain("raw-token-2");
  });

  test("a `get-session` that answers null while a rotation is still in flight waits for it, and keeps the successor", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let releaseRotation: () => void = () => {};
    const rotationGate = new Promise<void>((resolve) => (releaseRotation = resolve));
    const session = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      fetch: scripted(log, {
        "/auth/get-session": async () => {
          await readGate;
          // The Worker handled the rotation first and spent the presented credential.
          return { status: 200, body: null };
        },
        "/auth/token/rotate": async () => {
          await rotationGate;
          return rotated("raw-token-2", Date.parse("2026-01-08T00:00:00Z"));
        },
      }),
    });
    await session.adopt("raw-token-1");
    const reading = getSession(session.options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rotating = session.rotate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The null arrives before the rotation's answer does.
    releaseRead();
    await reading;
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseRotation();
    expect(await rotating).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.signedIn()).toBe(true);
    expect(store.data.get(BEARER_STORAGE_KEY)).toContain("raw-token-2");
  });

  test("a `get-session` that answers null while a rotation is in flight still signs out when the rotation leaves the credential in place", async () => {
    const log: Step[] = [];
    const store = memoryStore(log);
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let releaseRotation: () => void = () => {};
    const rotationGate = new Promise<void>((resolve) => (releaseRotation = resolve));
    const session = createBearerSession({
      origin: ORIGIN,
      store,
      device: DEVICE,
      fetch: scripted(log, {
        "/auth/get-session": async () => {
          await readGate;
          return { status: 200, body: null };
        },
        "/auth/token/rotate": async () => {
          await rotationGate;
          return { status: 503, body: { error: { code: "core/unavailable", message: "Try again." } } };
        },
      }),
    });
    await session.adopt("raw-token-1");
    const reading = getSession(session.options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rotating = session.rotate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseRead();
    await reading;
    releaseRotation();
    expect(await rotating).toMatchObject({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.signedIn()).toBe(false);
    expect(store.data.has(BEARER_STORAGE_KEY)).toBe(false);
  });
});

describe("a request the platform makes itself", () => {
  test("is handed the credential for the session's own origin only, after a rotation that was due", async () => {
    const log: Step[] = [];
    const time = clock();
    const expiry = time.now() + 7 * 24 * 3600_000;
    const session = createBearerSession({
      origin: ORIGIN,
      store: memoryStore(log),
      device: DEVICE,
      now: time.now,
      fetch: scripted(log, {
        "/auth/token/rotate": () => rotated("raw-token-2", time.now() + 7 * 24 * 3600_000),
        "/auth/get-session": () => ({
          status: 200,
          body: { session: { expiresAt: new Date(expiry).toISOString() }, user: { id: "u", email: "a@example.test" } },
        }),
      }),
    });
    expect(await session.authorization(`${ORIGIN}/organizations/marks/organization/o1`)).toBeNull();

    await session.adopt("raw-token-1");
    await getSession(session.options);
    expect(await session.authorization(`${ORIGIN}/organizations/marks/organization/o1`)).toBe("Bearer raw-token-1");

    time.set(expiry - ROTATION_MARGIN_MS + 1);
    expect(await session.authorization(`${ORIGIN}/organizations/marks/organization/o1`)).toBe("Bearer raw-token-2");
    expect(requests(log).filter((step) => step.url.endsWith("/token/rotate"))).toHaveLength(1);

    for (const url of [
      "https://elsewhere.example/x",
      `${ORIGIN}.elsewhere.example/x`,
      `${ORIGIN}@elsewhere.example/x`,
      "/organizations/marks/organization/o1",
    ]) {
      expect(await session.authorization(url), url).toBeNull();
    }
  });
});
