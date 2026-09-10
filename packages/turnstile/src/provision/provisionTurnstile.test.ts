// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { TURNSTILE_SECRET_NAME, type TurnstileSecrets, turnstileSecretsRegistry } from "../secret/registry";
import {
  deprovisionTurnstile,
  MANAGED_ENVIRONMENTS,
  productionWidgetName,
  provisionTurnstile,
  sitekeyVarName,
  type TurnstileDeprovisioner,
  type TurnstileProvisioner,
} from "./provisionTurnstile";
import { TEST_KEY_ENVIRONMENTS, TEST_SECRET, TURNSTILE_TEST_KEYS } from "./testKeys";

describe("naming helpers", () => {
  test("sitekey vars and production widget names are stable per mode", () => {
    expect(sitekeyVarName("visible")).toBe("TURNSTILE_SITEKEY_VISIBLE");
    expect(sitekeyVarName("invisible")).toBe("TURNSTILE_SITEKEY_INVISIBLE");
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

/** A provisioner that records calls and creates fresh production widgets by default. */
function fakeProvisioner(overrides: Partial<TurnstileProvisioner> = {}) {
  return {
    assertDomainAvailable: vi.fn().mockResolvedValue(undefined),
    writeDev: vi.fn().mockResolvedValue(undefined),
    writeManagedSecret: vi.fn().mockResolvedValue(undefined),
    writeManagedSitekeys: vi.fn().mockResolvedValue(undefined),
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
      writeDev: async (secret) => void written.set("dev", secret),
      writeManagedSecret: async (environment, secret) => void written.set(environment, secret),
      writeManagedSitekeys: async () => {},
      ensureProductionWidget: async (mode) => ({ sitekey: `real-${mode}`, secret: `secret-${mode}` }),
    },
    { modes: ["visible", "invisible"], productionDomain: "app.example.com" },
  );
  return written;
}

describe("provisionTurnstile", () => {
  test("writes the test secret to dev (.dev.vars) and staging (managed), and a real widget to production", async () => {
    const p = fakeProvisioner();
    const result = await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });

    const testSecret = { visible: { key: TEST_SECRET } };
    expect(p.writeDev).toHaveBeenCalledWith(testSecret, {
      TURNSTILE_SITEKEY_VISIBLE: TURNSTILE_TEST_KEYS.sitekey.visiblePass,
    });
    expect(p.writeManagedSecret).toHaveBeenCalledWith("staging", testSecret);
    expect(p.writeManagedSitekeys).toHaveBeenCalledWith("staging", {
      TURNSTILE_SITEKEY_VISIBLE: TURNSTILE_TEST_KEYS.sitekey.visiblePass,
    });

    expect(p.ensureProductionWidget).toHaveBeenCalledWith("visible", "app.example.com");
    expect(p.writeManagedSecret).toHaveBeenCalledWith("prod", { visible: { key: "secret-visible" } });
    expect(p.writeManagedSitekeys).toHaveBeenCalledWith("prod", { TURNSTILE_SITEKEY_VISIBLE: "real-visible" });
    expect(result.widgets).toEqual([{ mode: "visible", sitekey: "real-visible", created: true }]);
    expect(result.productionSecretWritten).toBe(true);
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
    const p = fakeProvisioner({ ensureProductionWidget: vi.fn(async () => ({ sitekey: "existing", secret: null })) });
    const result = await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });

    // staging is still written (test value), but production secret is left as-is and flagged so the caller warns.
    expect(p.writeManagedSecret).toHaveBeenCalledWith("staging", expect.any(Object));
    expect(p.writeManagedSecret).not.toHaveBeenCalledWith("prod", expect.any(Object));
    expect(p.writeManagedSitekeys).toHaveBeenCalledWith("prod", { TURNSTILE_SITEKEY_VISIBLE: "existing" });
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
  test("deletes each widget, the managed secret, and clears dev + managed sitekeys", async () => {
    const d = {
      deleteProductionWidget: vi.fn().mockResolvedValue(undefined),
      deleteManagedSecret: vi.fn().mockResolvedValue(undefined),
      clearDev: vi.fn().mockResolvedValue(undefined),
      clearManagedSitekeys: vi.fn().mockResolvedValue(undefined),
    } satisfies TurnstileDeprovisioner;

    await deprovisionTurnstile(d, ["visible", "invisible"]);

    expect(d.deleteProductionWidget).toHaveBeenCalledWith("visible");
    expect(d.deleteProductionWidget).toHaveBeenCalledWith("invisible");
    expect(d.deleteManagedSecret).toHaveBeenCalledTimes(1);
    expect(d.clearDev).toHaveBeenCalledWith(["visible", "invisible"]);
    expect(d.clearManagedSitekeys).toHaveBeenCalledWith(["visible", "invisible"]);
  });
});
