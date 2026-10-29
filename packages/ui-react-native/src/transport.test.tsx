// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthFetch, AuthRequestInit } from "@pithy-sh/auth/src/client/api";
import { getSession, signOut } from "@pithy-sh/auth/src/client/api";
import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { CONSENT_VISITOR_HEADER } from "@pithy-sh/consent/src/client/api";
import { Platform } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CONSENT_VISITOR_KEY,
  createTransport,
  DEVICE_ID_KEY,
  deviceInfo,
  secureStore,
} from "../templates/src/transport";
import { secureStore as stubStore } from "../testing/expo-secure-store";

const ORIGIN = "https://api.example.com";

interface Sent {
  url: string;
  init: AuthRequestInit | undefined;
}

/** A Worker that answers every route with `answer(url)`, recording what it was sent. */
function worker(answer: (url: string) => { status: number; body: unknown }): { fetch: AuthFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url, init });
      const { status, body } = answer(url);
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
}

const signedIn = (url: string) =>
  url.endsWith("/get-session")
    ? {
        status: 200,
        body: { user: { id: "u1", email: "ada@example.com" }, session: { expiresAt: "2999-01-01T00:00:00Z" } },
      }
    : { status: 200, body: {} };

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  vi.resetModules();
});

describe("on a phone, the session is a bearer credential", () => {
  test("an auth call goes to the Worker's origin with no cookie, carrying the device", async () => {
    const wire = worker(signedIn);
    const transport = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: wire.fetch,
    });
    await transport.adopt("raw-token");
    await getSession(transport.auth);
    const call = wire.sent.at(-1);
    expect(call?.url).toBe(`${ORIGIN}/auth/get-session`);
    expect(call?.init?.credentials).toBe("omit");
    expect(call?.init?.headers?.authorization).toBe("Bearer raw-token");
    expect(call?.init?.headers?.["x-pithy-platform"]).toBe("ios");
    expect(call?.init?.headers?.["x-pithy-device-id"]).toBe(stubStore.items.get(DEVICE_ID_KEY));
  });

  test("an adopted token is in the secure store before adopt resolves, and nowhere else", async () => {
    const transport = createTransport({
      platform: "android",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: worker(signedIn).fetch,
    });
    await transport.adopt("raw-token");
    expect(stubStore.items.get(BEARER_STORAGE_KEY)).toContain("raw-token");
  });

  test("a relaunch restores the stored credential before the first call", async () => {
    const first = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: worker(signedIn).fetch,
    });
    await first.adopt("raw-token");
    const wire = worker(signedIn);
    const relaunched = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: wire.fetch,
    });
    const result = await getSession(relaunched.auth);
    expect(result.ok && result.value?.user.email).toBe("ada@example.com");
    expect(wire.sent[0]?.init?.headers?.authorization).toBe("Bearer raw-token");
  });

  test("forget clears the credential here and in the store", async () => {
    const wire = worker(signedIn);
    const transport = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: wire.fetch,
    });
    await transport.adopt("raw-token");
    await signOut(transport.auth);
    await transport.forget();
    expect(stubStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
    await getSession(transport.auth);
    expect(wire.sent.at(-1)?.init?.headers?.authorization).toBeUndefined();
  });

  test("another capability's client presents the same credential to the same origin", async () => {
    const wire = worker(signedIn);
    const transport = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: wire.fetch,
    });
    await transport.adopt("raw-token");
    expect(transport.organization.origin).toBe(ORIGIN);
    expect(transport.capability.origin).toBe(ORIGIN);
    await transport.capability.fetch?.(`${ORIGIN}/payments/entitlements`);
    const call = wire.sent.at(-1);
    expect(call?.init?.headers?.authorization).toBe("Bearer raw-token");
    expect(call?.init?.headers?.["x-pithy-device-id"]).toBeUndefined();
  });

  test("a signed-out consent call sends consent's own visitor id, never the device id auth registers", async () => {
    const wire = worker(() => ({ status: 200, body: {} }));
    const transport = createTransport({
      platform: "android",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: wire.fetch,
    });
    await transport.capability.fetch?.(`${ORIGIN}/consent/me`);
    await transport.capability.fetch?.(`${ORIGIN}/consent/purposes`);
    await transport.capability.fetch?.(`${ORIGIN}/consentx/me`);
    await transport.capability.fetch?.(`${ORIGIN}/payments/entitlements`);
    const [me, purposes, lookalike, payments] = wire.sent.slice(-4);
    const visitor = stubStore.items.get(CONSENT_VISITOR_KEY);
    expect(visitor).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(visitor).not.toBe(stubStore.items.get(DEVICE_ID_KEY));
    expect(me?.init?.credentials).toBe("omit");
    expect(me?.init?.headers?.authorization).toBeUndefined();
    expect(me?.init?.headers?.[CONSENT_VISITOR_HEADER]).toBe(visitor);
    expect(purposes?.init?.headers?.[CONSENT_VISITOR_HEADER]).toBe(visitor);
    for (const call of [me, purposes, lookalike, payments]) {
      expect(call?.init?.headers?.["x-pithy-device-id"], call?.url).toBeUndefined();
    }
    expect(lookalike?.init?.headers?.[CONSENT_VISITOR_HEADER]).toBeUndefined();
    expect(payments?.init?.headers?.[CONSENT_VISITOR_HEADER]).toBeUndefined();
  });

  test("the session is opened once, however many calls race to it", async () => {
    const wire = worker(signedIn);
    const transport = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: wire.fetch,
    });
    const [a, b] = await Promise.all([transport.session(), transport.session()]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});

describe("an image the Worker serves", () => {
  test("on a phone, is drawn from the Worker's origin with the session's credential", async () => {
    const transport = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: worker(signedIn).fetch,
    });
    expect(await transport.image("/organizations/marks/organization/o1?v=1")).toEqual({
      uri: `${ORIGIN}/organizations/marks/organization/o1?v=1`,
    });
    await transport.adopt("raw-token");
    expect(await transport.image("/organizations/marks/organization/o1?v=1")).toEqual({
      uri: `${ORIGIN}/organizations/marks/organization/o1?v=1`,
      headers: { authorization: "Bearer raw-token" },
    });
  });

  test("on the web, is the path itself, and the page's cookie goes with it", async () => {
    const transport = createTransport({ platform: "web", origin: ORIGIN, authBasePath: "/auth", store: secureStore });
    expect(await transport.image("/organizations/marks/organization/o1")).toEqual({
      uri: "/organizations/marks/organization/o1",
    });
  });

  test("anything but a path on the Worker is no image, so the credential never goes elsewhere", async () => {
    const transport = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: worker(signedIn).fetch,
    });
    await transport.adopt("raw-token");
    for (const path of [
      "//elsewhere.example/x.png",
      "/\\elsewhere.example/x.png",
      "https://elsewhere.example/x.png",
      "x.png",
      "@elsewhere.example/x",
    ]) {
      expect(await transport.image(path), path).toBeNull();
    }
  });
});

describe("on the web, the session is the page's cookie", () => {
  test("calls are relative, carry no origin and no bearer, and nothing is stored", async () => {
    const transport = createTransport({ platform: "web", origin: ORIGIN, authBasePath: "/auth", store: secureStore });
    expect(transport.bearer).toBe(false);
    expect(transport.auth).toEqual({ basePath: "/auth" });
    expect(transport.organization).toEqual({});
    expect(transport.capability).toEqual({});
    expect(await transport.session()).toBeNull();
    await transport.adopt("ignored");
    expect(stubStore.items.size).toBe(0);
  });
});

describe("the device a sign-in registers", () => {
  test("its id is minted once and kept in the secure store across launches", async () => {
    const first = await deviceInfo(secureStore, "ios");
    const second = await deviceInfo(secureStore, "ios");
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).toBe(first.id);
    expect(first.platform).toBe("ios");
  });

  test("a store that refuses still yields a device, for this launch", async () => {
    stubStore.failing = true;
    const device = await deviceInfo(secureStore, "android");
    expect(device.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("Android names the hardware it reports", async () => {
    Platform.OS = "android";
    (Platform as unknown as { constants: Record<string, string> }).constants = {
      Manufacturer: "Google",
      Model: "Pixel 9",
    };
    const device = await deviceInfo(secureStore, "android");
    expect(device.model).toBe("Pixel 9");
    expect(device.name).toBe("Google Pixel 9");
  });
});

describe("the app's own transport", () => {
  test("picks bearer on a phone and cookie on the web, from Platform.OS", async () => {
    Platform.OS = "ios";
    const native = await import("../templates/src/transport");
    expect(native.transport.bearer).toBe(true);
    vi.resetModules();
    Platform.OS = "web";
    const web = await import("../templates/src/transport");
    expect(web.transport.bearer).toBe(false);
  });
});

describe("a change of who is signed in", () => {
  test("on a phone, is reported once the credential is stored or forgotten, until the listener stops", async () => {
    const transport = createTransport({
      platform: "ios",
      origin: ORIGIN,
      authBasePath: "/auth",
      store: secureStore,
      fetch: worker(signedIn).fetch,
    });
    const seen: (string | undefined)[] = [];
    const stop = transport.onChange(() => {
      seen.push(stubStore.items.get(BEARER_STORAGE_KEY));
    });
    await transport.adopt("raw-token");
    await transport.forget();
    stop();
    await transport.adopt("next-token");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("raw-token");
    expect(seen[1]).toBeUndefined();
  });

  test("on the web, is never reported: the cookie changes out of sight", async () => {
    const transport = createTransport({ platform: "web", origin: ORIGIN, authBasePath: "/auth", store: secureStore });
    const listener = vi.fn();
    transport.onChange(listener)();
    await transport.adopt("raw-token");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("a pinned credential", () => {
  const phone = (fetch: AuthFetch) =>
    createTransport({ platform: "ios", origin: ORIGIN, authBasePath: "/auth", store: secureStore, fetch });

  test("presents the credential held when it was pinned, whoever signs in or out after", async () => {
    const wire = worker(signedIn);
    const transport = phone(wire.fetch);
    await transport.adopt("ada-token");
    const pinned = await transport.pinned();
    await transport.adopt("bob-token");
    await getSession(pinned?.auth ?? {});
    await transport.forget();
    await pinned?.capability.fetch(`${ORIGIN}/payments/purchases`, {
      method: "POST",
      headers: { Authorization: "Bearer forged" },
    });
    expect(wire.sent.map((call) => [call.url, call.init?.headers?.authorization, call.init?.credentials])).toEqual([
      [`${ORIGIN}/auth/get-session`, "Bearer ada-token", "omit"],
      [`${ORIGIN}/payments/purchases`, "Bearer ada-token", "omit"],
    ]);
    expect(wire.sent.at(-1)?.init?.headers?.Authorization).toBeUndefined();
  });

  test("goes to the Worker's origin and nowhere else", async () => {
    const wire = worker(signedIn);
    const transport = phone(wire.fetch);
    await transport.adopt("ada-token");
    const pinned = await transport.pinned();
    for (const url of ["https://api.example.com.evil.test/x", "https://evil.test/", "/payments/purchases"]) {
      await expect(pinned?.capability.fetch(url)).rejects.toThrow(TypeError);
    }
    expect(wire.sent).toEqual([]);
  });

  test("is nothing when no credential is held, and nothing on the web", async () => {
    const wire = worker(signedIn);
    expect(await phone(wire.fetch).pinned()).toBeNull();
    const web = createTransport({ platform: "web", origin: ORIGIN, authBasePath: "/auth", store: secureStore });
    await web.adopt("raw-token");
    expect(await web.pinned()).toBeNull();
  });
});
