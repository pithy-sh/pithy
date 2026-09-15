// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { TURNSTILE_SECRET_NAME, type TurnstileSecrets, turnstileSecretsRegistry } from "../secret/registry";
import {
  deprovisionTurnstile,
  environmentsWithoutSitekeys,
  isStrandedSitekeyVar,
  MANAGED_ENVIRONMENTS,
  productionWidgetName,
  provisionTurnstile,
  type TurnstileDeprovisioner,
  type TurnstileProvisioner,
} from "./provisionTurnstile";
import { TEST_KEY_ENVIRONMENTS, TEST_SECRET } from "./testKeys";

describe("naming helpers", () => {
  test("production widget names are stable per mode", () => {
    expect(productionWidgetName("acme", "invisible")).toBe("acme-prod-turnstile-invisible");
    expect(productionWidgetName("acme", "visible")).toBe("acme-prod-turnstile-visible");
  });

  test("two projects in one account never share a widget name", () => {
    expect(productionWidgetName("acme", "visible")).not.toBe(productionWidgetName("globex", "visible"));
  });

  test("the environment slot is `prod`, the name of the environment the widget serves", () => {
    // Not cosmetic. Provisioning is reuse-or-create by name, so the day the spelling moved was the day
    // a re-run would have created a second widget beside the live one and written the front-end a
    // sitekey the old widget's secret cannot verify.
    for (const name of MANAGED_ENVIRONMENTS) expect(name).not.toBe("production");
    expect(productionWidgetName("acme", "visible")).toContain("-prod-");
  });

  test("the project segment is kebabbed, and an illegal one is refused rather than composed", () => {
    expect(productionWidgetName("Acme Corp", "visible")).toBe("acme-corp-prod-turnstile-visible");
    expect(() => productionWidgetName("2026-launch", "visible")).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
    );
  });
});

describe("isStrandedSitekeyVar", () => {
  test("names every var the #53 writer left behind, whichever mode it was for", () => {
    // Read by prefix, not built from the modes: a var for a mode this config no longer declares is exactly as
    // stranded as one for a mode it does, and a list derived from today's modes would walk past it.
    expect(isStrandedSitekeyVar("TURNSTILE_SITEKEY_VISIBLE")).toBe(true);
    expect(isStrandedSitekeyVar("TURNSTILE_SITEKEY_INVISIBLE")).toBe(true);
    expect(isStrandedSitekeyVar("TURNSTILE_SITEKEY_LEGACY")).toBe(true);
    expect(isStrandedSitekeyVar("TURNSTILE_SECRET")).toBe(false);
    expect(isStrandedSitekeyVar("MY_TURNSTILE_SITEKEY_VISIBLE")).toBe(false);
  });
});

describe("environmentsWithoutSitekeys", () => {
  test("names every environment a build cannot resolve a sitekey for, and none it can", () => {
    // Literals on both sides: the three a sitekey has a slot for, and two that a project really builds.
    expect(environmentsWithoutSitekeys(["staging", "live", "prod", "feature", "dev"])).toEqual(["live", "feature"]);
    expect(environmentsWithoutSitekeys(["dev", "staging", "prod"])).toEqual([]);
  });
});

/** A provisioner that records calls and creates fresh production widgets by default. */
function fakeProvisioner(overrides: Partial<TurnstileProvisioner> = {}) {
  return {
    assertDomainAvailable: vi.fn().mockResolvedValue(undefined),
    findProductionWidget: vi.fn().mockResolvedValue(null),
    assertSitekeysWritable: vi.fn().mockResolvedValue(undefined),
    writeDev: vi.fn().mockResolvedValue(undefined),
    writeManagedSecret: vi.fn().mockResolvedValue(undefined),
    writeSitekeys: vi.fn().mockResolvedValue(undefined),
    removeStrandedSitekeyVars: vi.fn().mockResolvedValue([]),
    ensureProductionWidget: vi.fn(async (mode: string) => ({ sitekey: `real-${mode}`, secret: `secret-${mode}` })),
    ...overrides,
  } satisfies TurnstileProvisioner;
}

/**
 * Every secret one full run hands a store, keyed by the environment it was written for.
 *
 * Both modes and fresh widgets, so all three write paths fire: `writeDev`, `writeManagedSecret` for
 * staging, and `writeManagedSecret` for prod. Recorded off a real provisioner rather than a mock's
 * call list, because what is under test is the value itself and nothing may reshape it on the way here.
 */
async function capturedWrites(): Promise<Map<string, TurnstileSecrets>> {
  const written = new Map<string, TurnstileSecrets>();
  await provisionTurnstile(
    {
      assertDomainAvailable: async () => {},
      findProductionWidget: async () => null,
      assertSitekeysWritable: async () => {},
      writeDev: async (secret) => void written.set("dev", secret),
      writeManagedSecret: async (environment, secret) => void written.set(environment, secret),
      writeSitekeys: async () => {},
      removeStrandedSitekeyVars: async () => [],
      ensureProductionWidget: async (mode) => ({ sitekey: `real-${mode}`, secret: `secret-${mode}` }),
    },
    { modes: ["visible", "invisible"], productionDomain: "app.example.com" },
  );
  return written;
}

describe("provisionTurnstile", () => {
  test("writes the test secret to dev and staging, and a real widget to production", async () => {
    const p = fakeProvisioner();
    const result = await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });

    const testSecret = { visible: { key: TEST_SECRET } };
    expect(p.writeDev).toHaveBeenCalledWith(testSecret);
    expect(p.writeManagedSecret).toHaveBeenCalledWith("staging", testSecret);
    expect(p.ensureProductionWidget).toHaveBeenCalledWith("visible", "app.example.com");
    expect(p.writeManagedSecret).toHaveBeenCalledWith("prod", { visible: { key: "secret-visible" } });
    expect(result.widgets).toEqual([{ mode: "visible", sitekey: "real-visible", created: true }]);
    expect(result.productionSecretWritten).toBe(true);
  });

  test("states every environment's sitekey in one write: test keys for dev and staging, the widget's for prod", async () => {
    // The config the build projects from, not a Worker var nothing reads (#590). Stated as literals here
    // rather than read off `testSitekey`, so this and the provisioner are two statements of one fact.
    const p = fakeProvisioner();
    const result = await provisionTurnstile(p, {
      modes: ["visible", "invisible"],
      productionDomain: "app.example.com",
    });

    const expected = {
      visible: { dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "real-visible" },
      invisible: { dev: "1x00000000000000000000BB", staging: "1x00000000000000000000BB", prod: "real-invisible" },
    };
    expect(p.writeSitekeys).toHaveBeenCalledTimes(1);
    expect(p.writeSitekeys).toHaveBeenCalledWith(expected);
    expect(result.sitekeys).toEqual(expected);
  });

  test("removes the stranded sitekey vars and reports what it removed", async () => {
    const stranded = [{ name: "TURNSTILE_SITEKEY_VISIBLE", environment: "prod" }];
    const p = fakeProvisioner({ removeStrandedSitekeyVars: vi.fn().mockResolvedValue(stranded) });
    const result = await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });

    expect(p.removeStrandedSitekeyVars).toHaveBeenCalledTimes(1);
    expect(result.strandedVarsRemoved).toEqual(stranded);
  });

  test("composes the production secret across both widgets as one JSON object", async () => {
    const p = fakeProvisioner();
    await provisionTurnstile(p, { modes: ["visible", "invisible"], productionDomain: "app.example.com" });
    expect(p.writeManagedSecret).toHaveBeenCalledWith("prod", {
      visible: { key: "secret-visible" },
      invisible: { key: "secret-invisible" },
    });
  });

  test("skips the production secret write when all widgets already exist (idempotent reuse)", async () => {
    const p = fakeProvisioner({
      findProductionWidget: vi.fn(async () => ({ sitekey: "existing" })),
      ensureProductionWidget: vi.fn(async () => ({ sitekey: "existing", secret: null })),
    });
    const result = await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });

    // staging is still written (test value), but production secret is left as-is and flagged so the caller warns.
    expect(p.writeManagedSecret).toHaveBeenCalledWith("staging", expect.any(Object));
    expect(p.writeManagedSecret).not.toHaveBeenCalledWith("prod", expect.any(Object));
    // The existing widget's sitekey still reaches config: it is the one value Cloudflare does return.
    expect(p.writeSitekeys).toHaveBeenCalledWith({ visible: expect.objectContaining({ prod: "existing" }) });
    expect(result.productionSecretWritten).toBe(false);
  });

  test("checks the domain is free before it writes anything at all", async () => {
    const p = fakeProvisioner({
      assertDomainAvailable: vi.fn().mockRejectedValue(new Error("domain taken")),
    });
    await expect(
      provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" }),
    ).rejects.toThrowError("domain taken");

    expect(p.assertDomainAvailable).toHaveBeenCalledWith("app.example.com");
    // Nothing was written — the guard runs before the first side effect, so a refusal leaves no debris.
    expect(p.writeDev).not.toHaveBeenCalled();
    expect(p.writeManagedSecret).not.toHaveBeenCalled();
    expect(p.ensureProductionWidget).not.toHaveBeenCalled();
    expect(p.writeSitekeys).not.toHaveBeenCalled();
  });

  test("allowSharedDomain skips the guard (CF itself permits several widgets per domain)", async () => {
    const p = fakeProvisioner();
    await provisionTurnstile(p, {
      modes: ["visible"],
      productionDomain: "app.example.com",
      allowSharedDomain: true,
    });
    expect(p.assertDomainAvailable).not.toHaveBeenCalled();
    expect(p.ensureProductionWidget).toHaveBeenCalledWith("visible", "app.example.com");
  });

  test("wires a test key into exactly the environments the gate relaxes for", async () => {
    // The join between this file and `http/middleware.ts` (#374). The gate accepts a test key's
    // action-less answer in `TEST_KEY_ENVIRONMENTS` and refuses it everywhere else, and that is only
    // sound while this function writes one into those same environments and no others.
    //
    // The left side is read back off the recorded calls rather than off the constant: `provisionTurnstile`
    // names `dev`, `staging` and `prod` itself, in its own body, so the two sides are independent
    // statements about the same fact and a change to either one is a red build.
    const written = await capturedWrites();

    const wired = [...written]
      .filter(([, secret]) => Object.values(secret).some((entry) => entry?.key === TEST_SECRET))
      .map(([environment]) => environment);
    expect(wired.sort()).toEqual([...TEST_KEY_ENVIRONMENTS].sort());
    // And the production secret it did write is a real widget's, not the test key under another name.
    expect(Object.values(written.get("prod") ?? {}).map((entry) => entry?.key)).not.toContain(TEST_SECRET);
  });

  test("errors on a mixed production state rather than writing a half-secret", async () => {
    const p = fakeProvisioner({
      findProductionWidget: vi.fn(async (mode: string) => (mode === "visible" ? null : { sitekey: "i" })),
      ensureProductionWidget: vi.fn(async (mode: string) =>
        mode === "visible" ? { sitekey: "v", secret: "new-v" } : { sitekey: "i", secret: null },
      ),
    });
    await expect(
      provisionTurnstile(p, { modes: ["visible", "invisible"], productionDomain: "app.example.com" }),
    ).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
    );
  });
});

/**
 * The property, on every path, against the schema the registry actually declares (#535).
 *
 * **No `JSON.parse` anywhere below, and that is the whole design of these cases.** The coverage this
 * replaced compared `writeDev`'s argument with `JSON.stringify({ visible: … })` — content, not
 * encoding — so it passed over a value that was serialized twice and passed equally over one that was
 * not. Three write paths shipped the double-encoded form under it. A parse step in a test is the test
 * doing the work the reader will not do: `storedVersion` (`@pithy-sh/secrets/src/dev/seedDevSecrets`)
 * hands the value to `entry.schema.safeParse` exactly as stored, and `TurnstileSecrets` is a
 * `z.strictObject`, so a string fails at the root — which is what `pithy doctor` reported.
 */
describe("the value provisioning hands each store", () => {
  test.for(["dev", "staging", "prod"])("%s gets the shape the registry declares", async (environment) => {
    const stored = (await capturedWrites()).get(environment);
    const entry = turnstileSecretsRegistry[TURNSTILE_SECRET_NAME];

    // The whole bug in one line: a string here is double-encoded, whatever it parses to.
    expect(typeof stored).not.toBe("string");
    // And the check the dev secrets reader actually performs, against the value as written.
    expect(entry?.schema.safeParse(stored).success).toBe(true);
  });
});

describe("deprovisionTurnstile", () => {
  test("deletes each widget and the managed secret, blanks the production sitekeys, and strips stranded vars", async () => {
    const d = {
      assertSitekeysWritable: vi.fn().mockResolvedValue(undefined),
      deleteProductionWidget: vi.fn().mockResolvedValue(undefined),
      deleteManagedSecret: vi.fn().mockResolvedValue(undefined),
      clearDev: vi.fn().mockResolvedValue(undefined),
      clearProductionSitekeys: vi.fn().mockResolvedValue(undefined),
      removeStrandedSitekeyVars: vi.fn().mockResolvedValue([]),
    } satisfies TurnstileDeprovisioner;

    await deprovisionTurnstile(d, ["visible", "invisible"]);

    expect(d.deleteProductionWidget).toHaveBeenCalledWith("visible");
    expect(d.deleteProductionWidget).toHaveBeenCalledWith("invisible");
    expect(d.deleteManagedSecret).toHaveBeenCalledTimes(1);
    expect(d.clearDev).toHaveBeenCalledWith(["visible", "invisible"]);
    expect(d.clearProductionSitekeys).toHaveBeenCalledWith(["visible", "invisible"]);
    expect(d.removeStrandedSitekeyVars).toHaveBeenCalledTimes(1);
  });
});

/**
 * **Before the sitekey check, a run only reads** (#590 review).
 *
 * The sitekey writer's refusals read the config source alone, so they can be decided before anything is
 * created. A run that checks them last has minted a production widget and stored its secret by the time it
 * refuses. Stated positively, over every step the seam has: each recorded call before
 * `assertSitekeysWritable` returns is one of the named reads, and a refused check is followed by nothing.
 *
 * The recorder is a Proxy over the whole seam, so a step added to it later is recorded without anyone
 * listing it here — and is not a read unless someone says so below.
 *
 * What it does not see: a side effect the orchestrator makes other than through the seam (it makes none
 * today), and whether a seam method named a read really only reads — `turnstileProvisioner.test.ts` holds the
 * live provisioner to that, over a stubbed Cloudflare API. Nor can any check made before the write catch the
 * writer's read-back refusal, which needs the written file by construction.
 */
describe("a refused sitekey check leaves nothing written", () => {
  /** The steps that change nothing: the domain listing, the widget lookup, and the check itself. */
  const PROVISION_READS: ReadonlySet<string> = new Set([
    "assertDomainAvailable",
    "findProductionWidget",
    "assertSitekeysWritable",
  ]);
  const DEPROVISION_READS: ReadonlySet<string> = new Set(["assertSitekeysWritable"]);

  /** Wrap a seam so every method call is recorded by name, in order. */
  function recorded<T extends object>(seam: T): { seam: T; calls: string[] } {
    const calls: string[] = [];
    const proxy = new Proxy(seam, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return value.apply(target, args);
        };
      },
    });
    return { seam: proxy, calls };
  }

  const refusal = () => Promise.reject(new Error("sitekeys refused"));

  test("provision: a refused check follows only reads, and nothing runs after it", async () => {
    const { seam, calls } = recorded(fakeProvisioner({ assertSitekeysWritable: vi.fn(refusal) }));

    await expect(
      provisionTurnstile(seam, { modes: ["visible", "invisible"], productionDomain: "app.example.com" }),
    ).rejects.toThrow("sitekeys refused");

    expect(calls).toContain("assertSitekeysWritable");
    expect(calls.filter((name) => !PROVISION_READS.has(name))).toEqual([]);
  });

  test("provision: the check is asked for the sitekeys the write will carry, an unissued prod as null", async () => {
    const p = fakeProvisioner({
      findProductionWidget: vi.fn(async () => ({ sitekey: "existing-v" })),
      ensureProductionWidget: vi.fn(async () => ({ sitekey: "existing-v", secret: null })),
    });
    // An existing widget's sitekey is known before anything is written; a widget still to be created has none.
    await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });
    const q = fakeProvisioner();
    await provisionTurnstile(q, { modes: ["invisible"], productionDomain: "app.example.com" });

    expect(p.assertSitekeysWritable).toHaveBeenCalledWith({
      visible: { dev: "1x00000000000000000000AA", staging: "1x00000000000000000000AA", prod: "existing-v" },
    });
    expect(q.assertSitekeysWritable).toHaveBeenCalledWith({
      invisible: { dev: "1x00000000000000000000BB", staging: "1x00000000000000000000BB", prod: null },
    });
  });

  test("provision: a mixed production state is refused before anything is written", async () => {
    const { seam, calls } = recorded(
      fakeProvisioner({
        findProductionWidget: vi.fn(async (mode: string) => (mode === "visible" ? { sitekey: "v" } : null)),
      }),
    );

    await expect(
      provisionTurnstile(seam, { modes: ["visible", "invisible"], productionDomain: "app.example.com" }),
    ).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
    );
    expect(calls.filter((name) => !PROVISION_READS.has(name))).toEqual([]);
  });

  test("deprovision: a refused check follows only reads, and nothing is deleted", async () => {
    const d = {
      assertSitekeysWritable: vi.fn(refusal),
      deleteProductionWidget: vi.fn().mockResolvedValue(undefined),
      deleteManagedSecret: vi.fn().mockResolvedValue(undefined),
      clearDev: vi.fn().mockResolvedValue(undefined),
      clearProductionSitekeys: vi.fn().mockResolvedValue(undefined),
      removeStrandedSitekeyVars: vi.fn().mockResolvedValue([]),
    } satisfies TurnstileDeprovisioner;
    const { seam, calls } = recorded(d);

    await expect(deprovisionTurnstile(seam, ["visible"])).rejects.toThrow("sitekeys refused");

    expect(calls).toContain("assertSitekeysWritable");
    expect(calls.filter((name) => !DEPROVISION_READS.has(name))).toEqual([]);
    expect(d.assertSitekeysWritable).toHaveBeenCalledWith({ visible: { prod: "" } });
  });
});
