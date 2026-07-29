import { describe, expect, test, vi } from "vitest";
import { CACHE_MS, type FetchLike, fetchLatestVersion, refreshCliState, registryUrl } from "./check";
import { defaultState, type NotifierState } from "./state";

/** A `fetch` that returns one canned JSON body with status 200. */
function okFetch(body: unknown): FetchLike {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

describe("registryUrl", () => {
  test("builds the scoped latest-manifest URL", () => {
    expect(registryUrl("cli")).toBe("https://registry.npmjs.org/@pithy-sh%2Fcli/latest");
    expect(registryUrl("auth")).toBe("https://registry.npmjs.org/@pithy-sh%2Fauth/latest");
  });
});

describe("fetchLatestVersion", () => {
  test("reads the version and defaults security to not-flagged", async () => {
    const info = await fetchLatestVersion("cli", { fetch: okFetch({ version: "1.3.0" }) });
    expect(info).toEqual({ version: "1.3.0", securityFlagged: false });
  });

  test("reads a top-level pithy:security marker", async () => {
    const info = await fetchLatestVersion("cli", { fetch: okFetch({ version: "1.2.1", "pithy:security": true }) });
    expect(info).toEqual({ version: "1.2.1", securityFlagged: true });
  });

  test("reads a nested pithy.security marker", async () => {
    const info = await fetchLatestVersion("cli", { fetch: okFetch({ version: "1.2.1", pithy: { security: true } }) });
    expect(info?.securityFlagged).toBe(true);
  });

  test("non-200 → null (silent)", async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    expect(await fetchLatestVersion("cli", { fetch })).toBeNull();
  });

  test("a rejected fetch → null (silent)", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("offline");
    };
    expect(await fetchLatestVersion("cli", { fetch })).toBeNull();
  });

  test("a missing version field → null", async () => {
    expect(await fetchLatestVersion("cli", { fetch: okFetch({ name: "cli" }) })).toBeNull();
  });
});

describe("refreshCliState — cache gate", () => {
  const base: NotifierState = { ...defaultState(), latestVersion: "1.2.0", installer: "bun" };

  test("fresh cache makes no network request", async () => {
    const fetch = okFetch({ version: "9.9.9" });
    const now = () => 1_000_000;
    const state: NotifierState = { ...base, lastCheck: now() - 1000 }; // 1s ago, well within 24h
    const result = await refreshCliState(state, { fetch, now });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.updated).toBe(false);
    expect(result.state).toBe(state);
  });

  test("stale cache makes exactly one request and updates lastCheck/latestVersion", async () => {
    const fetch = okFetch({ version: "1.3.0" });
    const now = () => 2_000_000_000;
    const state: NotifierState = { ...base, lastCheck: now() - CACHE_MS - 1 };
    const result = await refreshCliState(state, { fetch, now });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(registryUrl("cli"), expect.anything());
    expect(result.updated).toBe(true);
    expect(result.state.latestVersion).toBe("1.3.0");
    expect(result.state.lastCheck).toBe(now());
  });

  test("bypassCache forces a request even when the cache is fresh", async () => {
    const fetch = okFetch({ version: "1.3.0" });
    const now = () => 1_000_000;
    const state: NotifierState = { ...base, lastCheck: now() };
    const result = await refreshCliState(state, { fetch, now, bypassCache: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.state.latestVersion).toBe("1.3.0");
  });

  test("network failure leaves state unchanged and writes nothing", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("boom");
    };
    const now = () => 5_000_000_000;
    const state: NotifierState = { ...base, lastCheck: 0 }; // stale
    const result = await refreshCliState(state, { fetch, now });
    expect(result.updated).toBe(false);
    expect(result.state).toEqual(state);
    expect(result.state.latestVersion).toBe("1.2.0"); // cached value preserved
  });

  test("detects the installer once when it is still unknown", async () => {
    const fetch = okFetch({ version: "1.3.0" });
    const now = () => 5_000_000_000;
    const state: NotifierState = { ...defaultState(), installer: "unknown", lastCheck: 0 };
    const result = await refreshCliState(state, { fetch, now, argv1: "/home/u/.bun/bin/pithy" });
    expect(result.state.installer).toBe("bun");
  });

  test("does not re-detect the installer when state already holds one", async () => {
    const fetch = okFetch({ version: "1.3.0" });
    const now = () => 5_000_000_000;
    const state: NotifierState = { ...defaultState(), installer: "brew", lastCheck: 0 };
    const result = await refreshCliState(state, { fetch, now, argv1: "/home/u/.bun/bin/pithy" });
    expect(result.state.installer).toBe("brew");
  });
});
