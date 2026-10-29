// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { AUTH_DISABLED } from "@pithy-sh/ui-core/src/config";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linking } from "../testing/expo-linking";
import { secureStore } from "../testing/expo-secure-store";

const links = vi.hoisted(() => ({ universal: null as string | null }));

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  authConfig: { ...AUTH_DISABLED, enabled: true },
  get universalLinkOrigin() {
    return links.universal;
  },
}));

const ORIGIN = "http://localhost:8787";

interface Call {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}

let calls: Call[] = [];
let answer: (url: string, init: Call["init"]) => { status: number; body: unknown };

const json = (status: number, body: unknown) => ({ status, body });

beforeEach(() => {
  calls = [];
  links.universal = null;
  answer = (url) => {
    if (url.endsWith("/get-session")) return json(200, { user: { id: "u1", email: "ada@example.com" } });
    if (url.endsWith("/handoff")) return json(200, { token: "traded-token", expiresAt: "2999-01-01T00:00:00Z" });
    if (url.endsWith("/sign-in/social")) return json(200, { redirect: false, token: "id-token-session", user: {} });
    return json(200, {});
  };
  vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    const { status, body } = answer(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load(platform: "ios" | "android" | "web") {
  Platform.OS = platform;
  return import("../templates/src/session");
}

/** The base64url SHA-256 of `text`, as RFC 7636's S256 computes it. */
async function s256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("a redirect sign-in on a phone", () => {
  test("returns to the app's own link carrying the challenge of a verifier only the app holds", async () => {
    const session = await load("ios");
    const callbackURL = await session.beginHandoff("/callback");
    expect(callbackURL.startsWith(`${linking.scheme}://callback?handoff_challenge=`)).toBe(true);
    const verifier = secureStore.items.get(session.HANDOFF_VERIFIER_KEY);
    expect(verifier).toBeTruthy();
    const challenge = decodeURIComponent(callbackURL.split("handoff_challenge=")[1] ?? "");
    expect(challenge).toBe(await s256(verifier ?? ""));
  });

  test("keeps a resume target on the link, ahead of the challenge", async () => {
    const session = await load("android");
    const callbackURL = await session.beginHandoff("/callback?resume=%2Fauth%2Fx");
    expect(callbackURL).toMatch(/^pithyapp:\/\/callback\?resume=%2Fauth%2Fx&handoff_challenge=/);
  });

  test("trades the code and the verifier once, adopts the token, and forgets the verifier", async () => {
    const session = await load("ios");
    await session.beginHandoff("/callback");
    const verifier = secureStore.items.get(session.HANDOFF_VERIFIER_KEY);
    const [first, second] = await Promise.all([
      session.completeHandoff("one-time"),
      session.completeHandoff("one-time"),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    const trades = calls.filter((call) => call.url === `${ORIGIN}/auth/handoff`);
    expect(trades).toHaveLength(1);
    expect(JSON.parse(String(trades[0]?.init.body))).toEqual({ code: "one-time", verifier });
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("traded-token");
    expect(secureStore.items.has(session.HANDOFF_VERIFIER_KEY)).toBe(false);
    expect(calls.at(-1)?.init.headers?.authorization).toBe("Bearer traded-token");
  });

  test("a code with no sign-in waiting for it is refused without asking the Worker", async () => {
    const session = await load("ios");
    expect(await session.completeHandoff("stray")).toEqual({ ok: false, code: session.NO_HANDOFF });
    expect(calls).toEqual([]);
  });

  test("a refused trade says why, and stores no session", async () => {
    answer = () =>
      json(400, { error: { code: "auth/handoff_invalid", message: "That sign-in link has expired.", action: null } });
    const session = await load("ios");
    await session.beginHandoff("/callback");
    expect(await session.completeHandoff("spent")).toEqual({ ok: false, code: "auth/handoff_invalid" });
    expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
  });

  test("a trade the Worker never heard can be tried again with the same code", async () => {
    let offline = true;
    const reach = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
      if (offline && url.endsWith("/handoff")) throw new TypeError("Network request failed");
      return reach(url, init);
    });
    const session = await load("ios");
    await session.beginHandoff("/callback");
    expect(await session.completeHandoff("one-time")).toEqual({ ok: false, code: "client/unreachable" });
    offline = false;
    expect(await session.completeHandoff("one-time")).toEqual({ ok: true });
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("traded-token");
  });

  test("a trade that throws is not kept: the same code is traded again", async () => {
    let broken = true;
    vi.doMock("@pithy-sh/auth/src/client/handoff", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@pithy-sh/auth/src/client/handoff")>();
      return {
        ...actual,
        exchangeHandoff: (...args: Parameters<typeof actual.exchangeHandoff>) => {
          if (!broken) return actual.exchangeHandoff(...args);
          broken = false;
          return Promise.reject(new Error("The trade broke."));
        },
      };
    });
    try {
      const session = await load("ios");
      await session.beginHandoff("/callback");
      await expect(session.completeHandoff("one-time")).rejects.toThrow("The trade broke.");
      expect(await session.completeHandoff("one-time")).toEqual({ ok: true });
      expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("traded-token");
    } finally {
      vi.doUnmock("@pithy-sh/auth/src/client/handoff");
    }
  });

  test("a trade the Worker refused stays refused: the code is not sent twice", async () => {
    answer = () =>
      json(400, { error: { code: "auth/handoff_invalid", message: "That sign-in link has expired.", action: null } });
    const session = await load("ios");
    await session.beginHandoff("/callback");
    expect(await session.completeHandoff("spent")).toEqual({ ok: false, code: "auth/handoff_invalid" });
    expect(await session.completeHandoff("spent")).toEqual({ ok: false, code: "auth/handoff_invalid" });
    expect(calls.filter((call) => call.url === `${ORIGIN}/auth/handoff`)).toHaveLength(1);
  });

  test("a stray link with a junk code does not cancel the sign-in waiting for its own code", async () => {
    answer = (url, init) => {
      if (url.endsWith("/handoff") && JSON.parse(String(init.body)).code !== "real") {
        return json(400, { error: { code: "auth/handoff_invalid", message: "Expired.", action: null } });
      }
      if (url.endsWith("/handoff")) return json(200, { token: "traded-token", expiresAt: "2999-01-01T00:00:00Z" });
      return json(200, { user: { id: "u1", email: "ada@example.com" } });
    };
    const session = await load("ios");
    await session.beginHandoff("/callback");
    const verifier = secureStore.items.get(session.HANDOFF_VERIFIER_KEY);
    expect(await session.completeHandoff("junk")).toEqual({ ok: false, code: "auth/handoff_invalid" });
    expect(secureStore.items.get(session.HANDOFF_VERIFIER_KEY)).toBe(verifier);
    expect(await session.completeHandoff("real")).toEqual({ ok: true });
    const trades = calls.filter((call) => call.url === `${ORIGIN}/auth/handoff`);
    expect(JSON.parse(String(trades.at(-1)?.init.body))).toEqual({ code: "real", verifier });
    expect(secureStore.items.has(session.HANDOFF_VERIFIER_KEY)).toBe(false);
  });

  test("returns to the universal link when the app has one, not the app's scheme", async () => {
    links.universal = "https://links.example.com";
    const session = await load("ios");
    const callbackURL = await session.beginHandoff("/callback?resume=%2Fauth%2Fx");
    expect(callbackURL).toMatch(/^https:\/\/links\.example\.com\/callback\?resume=%2Fauth%2Fx&handoff_challenge=/);
    expect(session.returnLink("/callback")).toBe("https://links.example.com/callback");
  });

  test("returns to the app's scheme when no universal link is set", async () => {
    const session = await load("ios");
    expect(session.returnLink("/callback")).toBe("pithyapp://callback");
  });

  test("an abandoned sign-in forgets its verifier", async () => {
    const session = await load("ios");
    await session.beginHandoff("/callback");
    await session.abandonHandoff();
    expect(secureStore.items.has(session.HANDOFF_VERIFIER_KEY)).toBe(false);
  });
});

describe("a native id-token sign-in", () => {
  test("posts the provider's token to the social route, with the device, and adopts the session", async () => {
    const session = await load("ios");
    expect(await session.signInWithIdToken("apple", { token: "identity", nonce: "raw" })).toEqual({ ok: true });
    const post = calls.find((call) => call.url === `${ORIGIN}/auth/sign-in/social`);
    expect(JSON.parse(String(post?.init.body))).toEqual({
      provider: "apple",
      idToken: { token: "identity", nonce: "raw" },
    });
    expect(post?.init.headers?.["x-pithy-platform"]).toBe("ios");
    expect(post?.init.credentials).toBe("omit");
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("id-token-session");
  });

  test("a refusal comes back with its code, and nothing is stored", async () => {
    answer = () => json(403, { error: { code: "auth/account_suspended", message: "Suspended.", action: null } });
    const session = await load("android");
    expect(await session.signInWithIdToken("google", { token: "id" })).toEqual({
      ok: false,
      code: "auth/account_suspended",
    });
    expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
  });

  test("Apple's name and address go with the token when Apple handed them over", async () => {
    const session = await load("ios");
    await session.signInWithIdToken("apple", {
      token: "identity",
      nonce: "raw",
      user: { name: { firstName: "Ada", lastName: "Lovelace" }, email: "ada@example.com" },
    });
    const post = calls.find((call) => call.url === `${ORIGIN}/auth/sign-in/social`);
    expect(JSON.parse(String(post?.init.body)).idToken.user).toEqual({
      name: { firstName: "Ada", lastName: "Lovelace" },
      email: "ada@example.com",
    });
  });

  test("an answer with no session in it is a sign-in that did not take", async () => {
    answer = () => json(200, { redirect: false });
    const session = await load("ios");
    const outcome = await session.signInWithIdToken("apple", { token: "identity" });
    expect(outcome.ok).toBe(false);
  });
});
