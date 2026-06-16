import { describe, expect, it } from "vitest";
import { loadIntegrationCreds, parseR2Creds, uniqueName, withThrowawayResource } from "./harness";

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
