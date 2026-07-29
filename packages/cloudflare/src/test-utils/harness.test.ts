import { describe, expect, it } from "vitest";
import {
  loadIntegrationCreds,
  parseR2Creds,
  reapStaleTestResources,
  staleTestResourceNames,
  testResourceAge,
  uniqueName,
  withThrowawayResource,
} from "./harness";

describe("uniqueName", () => {
  it("uses the default prefix", () => {
    expect(uniqueName()).toMatch(/^pithy-int-test-/);
  });

  it("honors a custom prefix", () => {
    expect(uniqueName("pithy-int-kv")).toMatch(/^pithy-int-kv-/);
  });

  it("never repeats across rapid calls", () => {
    const names = new Set(Array.from({ length: 100 }, () => uniqueName()));
    expect(names.size).toBe(100);
  });

  it("stays in the lowercase a-z0-9- charset every CF resource name accepts", () => {
    expect(uniqueName("pithy-int-r2")).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("withThrowawayResource", () => {
  it("creates, exercises, then tears down — in order — and returns the exercise result", async () => {
    const calls: string[] = [];
    const result = await withThrowawayResource(
      async () => {
        calls.push("create");
        return { id: "res-1" };
      },
      async (resource) => {
        calls.push(`exercise:${resource.id}`);
        return 42;
      },
      async (resource) => {
        calls.push(`teardown:${resource.id}`);
      },
    );

    expect(result).toBe(42);
    expect(calls).toEqual(["create", "exercise:res-1", "teardown:res-1"]);
  });

  it("tears down even when exercise throws, and rethrows the original error", async () => {
    const calls: string[] = [];
    const boom = new Error("exercise failed");

    await expect(
      withThrowawayResource(
        async () => ({ id: "res-2" }),
        async () => {
          throw boom;
        },
        async (resource) => {
          calls.push(`teardown:${resource.id}`);
        },
      ),
    ).rejects.toBe(boom);

    expect(calls).toEqual(["teardown:res-2"]);
  });

  it("does not tear down when creation itself fails — nothing was created to clean up", async () => {
    let toreDown = false;

    await expect(
      withThrowawayResource(
        async () => {
          throw new Error("create failed");
        },
        async () => "unreached",
        async () => {
          toreDown = true;
        },
      ),
    ).rejects.toThrow("create failed");

    expect(toreDown).toBe(false);
  });
});

describe("parseR2Creds", () => {
  it("parses a well-formed R2_CREDENTIALS blob through the canonical schema", () => {
    expect(parseR2Creds('{"accessKeyId":"ak","secretAccessKey":"sk"}')).toEqual({
      accessKeyId: "ak",
      secretAccessKey: "sk",
    });
  });

  it("returns null when unset (the R2 suite then skips)", () => {
    expect(parseR2Creds(undefined)).toBeNull();
    expect(parseR2Creds("")).toBeNull();
  });

  it("throws on a set-but-malformed or incomplete blob — a misconfiguration surfaced loudly", () => {
    expect(() => parseR2Creds("not json")).toThrow();
    expect(() => parseR2Creds('{"accessKeyId":"ak"}')).toThrow(); // missing secretAccessKey
    expect(() => parseR2Creds('{"accessKeyId":"","secretAccessKey":"sk"}')).toThrow(); // empty key fails min(1)
  });
});

describe("loadIntegrationCreds", () => {
  it("returns the credential fields with consistent hasCreds and r2 shapes", () => {
    const creds = loadIntegrationCreds();
    expect(typeof creds.accountId).toBe("string");
    expect(typeof creds.apiToken).toBe("string");
    expect(typeof creds.secretsStoreId).toBe("string");
    // hasCreds is true exactly when both the account id and the token are present.
    expect(creds.hasCreds).toBe(Boolean(creds.accountId && creds.apiToken));
    // r2 is either null or a fully-populated key pair — never half-parsed.
    expect(creds.r2 === null || (Boolean(creds.r2.accessKeyId) && Boolean(creds.r2.secretAccessKey))).toBe(true);
  });
});

/**
 * The reaper deletes live resources from a real Cloudflare account, so the question that matters is not
 * "does it find debris" but "can it ever touch something that is not ours". These are mostly about the
 * second one.
 */

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("testResourceAge", () => {
  it("reads the age out of a name uniqueName actually produced", () => {
    const age = testResourceAge(uniqueName("pithy-int-vec"), Date.now() + 5_000);
    expect(age).not.toBeNull();
    expect(age ?? -1).toBeGreaterThanOrEqual(0);
  });

  it("returns the elapsed milliseconds for a well-formed name", () => {
    expect(testResourceAge(`pithy-int-vec-${NOW - HOUR}-1-ab12cd`, NOW)).toBe(HOUR);
  });

  it.each([
    ["a real resource that merely starts similarly", "pithy-integration-db-123"],
    ["a resource with no prefix at all", "my-production-bucket"],
    ["a prefixed name with no timestamp segment", "pithy-int-onlyname"],
    ["a timestamp that is not a number", "pithy-int-vec-notanumber-1-ab12cd"],
    ["a fractional timestamp", "pithy-int-vec-123.5-1-ab12cd"],
    ["a zero timestamp", "pithy-int-vec-0-1-ab12cd"],
  ])("refuses to age %s", (_label, name) => {
    expect(testResourceAge(name, NOW)).toBeNull();
  });

  it("refuses a timestamp in the future — clock skew must not read as ancient", () => {
    expect(testResourceAge(`pithy-int-vec-${NOW + HOUR}-1-ab12cd`, NOW)).toBeNull();
  });
});

describe("staleTestResourceNames", () => {
  const fresh = `pithy-int-vec-${NOW - 60_000}-1-aaaaaa`;
  const old = `pithy-int-vec-${NOW - 3 * HOUR}-1-bbbbbb`;
  const foreign = "customer-production-index";

  it("selects only our own names, and only the old ones", () => {
    expect(staleTestResourceNames([fresh, old, foreign], { now: NOW })).toEqual([old]);
  });

  it("leaves a resource a concurrent run could still be using", () => {
    // The hour threshold exists so a suite that takes minutes is never reaped out from under itself.
    expect(staleTestResourceNames([fresh], { now: NOW })).toEqual([]);
  });

  it("reaps at exactly the threshold, so the boundary is not ambiguous", () => {
    expect(staleTestResourceNames([`pithy-int-x-${NOW - HOUR}-1-cccccc`], { now: NOW })).toHaveLength(1);
  });

  it("never selects a name it could not age, whatever the threshold", () => {
    expect(staleTestResourceNames([foreign, "pithy-int-malformed"], { now: NOW, staleAfterMs: 0 })).toEqual([]);
  });

  it("returns nothing for an empty account", () => {
    expect(staleTestResourceNames([], { now: NOW })).toEqual([]);
  });
});

/**
 * The reaper itself, not just the predicate it consults.
 *
 * `staleTestResourceNames` being correct proves nothing about whether the reaper actually calls it — a
 * version that deleted every name it listed would pass every test above. These cover the wiring, because
 * this is the one code path in the repo that removes live Cloudflare resources.
 */
describe("reapStaleTestResources", () => {
  const NOW_ = 1_800_000_000_000;
  const HOUR_ = 60 * 60 * 1000;
  const stale = `pithy-int-vec-${NOW_ - 3 * HOUR_}-1-aaaaaa`;
  const fresh = `pithy-int-vec-${NOW_ - 60_000}-1-bbbbbb`;
  const foreign = "customer-production-index";

  /** A reapable kind that records what it was asked to remove instead of removing anything. */
  function fakeKind(names: string[], failOn?: string) {
    const removed: string[] = [];
    return {
      removed,
      kind: {
        label: "test resource",
        list: async () => names,
        remove: async (name: string) => {
          if (name === failOn) throw new Error("remove failed");
          removed.push(name);
        },
      },
    };
  }

  it("removes only the stale names, and leaves fresh and foreign ones alone", async () => {
    const { kind, removed } = fakeKind([stale, fresh, foreign]);
    const result = await reapStaleTestResources(kind, { now: NOW_ });
    expect(removed).toEqual([stale]);
    expect(result.reaped).toEqual([stale]);
    expect(result.failed).toEqual([]);
  });

  it("removes nothing at all when everything is fresh", async () => {
    const { kind, removed } = fakeKind([fresh, foreign]);
    await reapStaleTestResources(kind, { now: NOW_ });
    expect(removed).toEqual([]);
  });

  it("reports a failed removal instead of throwing — a reaper must not fail the suite it helps", async () => {
    const other = `pithy-int-vec-${NOW_ - 4 * HOUR_}-2-cccccc`;
    const { kind, removed } = fakeKind([stale, other], stale);
    const result = await reapStaleTestResources(kind, { now: NOW_ });
    expect(result.failed).toEqual([stale]);
    // The failure must not stop the rest: the second stale resource is still reclaimed.
    expect(removed).toEqual([other]);
    expect(result.reaped).toEqual([other]);
  });

  it("survives a listing failure without throwing, and removes nothing", async () => {
    const removed: string[] = [];
    const result = await reapStaleTestResources({
      label: "test resource",
      list: async () => {
        throw new Error("list failed");
      },
      remove: async (name) => void removed.push(name),
    });
    expect(result).toEqual({ reaped: [], failed: [] });
    expect(removed).toEqual([]);
  });

  it("honours a caller-supplied threshold, so a suite can reap aggressively on purpose", async () => {
    const { kind, removed } = fakeKind([fresh]);
    await reapStaleTestResources(kind, { now: NOW_, staleAfterMs: 0 });
    expect(removed).toEqual([fresh]);
  });

  it("never removes a name it cannot age, even at a zero threshold", async () => {
    const { kind, removed } = fakeKind([foreign, "pithy-int-malformed"]);
    await reapStaleTestResources(kind, { now: NOW_, staleAfterMs: 0 });
    expect(removed).toEqual([]);
  });
});
