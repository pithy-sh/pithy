// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import {
  deprovisionTurnstile,
  MANAGED_ENVIRONMENTS,
  productionWidgetName,
  provisionTurnstile,
  sitekeyVarName,
  type TurnstileDeprovisioner,
  type TurnstileProvisioner,
} from "./provisionTurnstile";
import { TEST_SECRET, TURNSTILE_TEST_KEYS } from "./testKeys";

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

describe("provisionTurnstile", () => {
  test("writes the test secret to dev (.dev.vars) and staging (managed), and a real widget to production", async () => {
    const p = fakeProvisioner();
    const result = await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });

    const testSecret = JSON.stringify({ visible: { key: TEST_SECRET } });
    expect(p.writeDev).toHaveBeenCalledWith(testSecret, {
      TURNSTILE_SITEKEY_VISIBLE: TURNSTILE_TEST_KEYS.sitekey.visiblePass,
    });
    expect(p.writeManagedSecret).toHaveBeenCalledWith("staging", testSecret);
    expect(p.writeManagedSitekeys).toHaveBeenCalledWith("staging", {
      TURNSTILE_SITEKEY_VISIBLE: TURNSTILE_TEST_KEYS.sitekey.visiblePass,
    });

    expect(p.ensureProductionWidget).toHaveBeenCalledWith("visible", "app.example.com");
    expect(p.writeManagedSecret).toHaveBeenCalledWith("prod", JSON.stringify({ visible: { key: "secret-visible" } }));
    expect(p.writeManagedSitekeys).toHaveBeenCalledWith("prod", { TURNSTILE_SITEKEY_VISIBLE: "real-visible" });
    expect(result.widgets).toEqual([{ mode: "visible", sitekey: "real-visible", created: true }]);
    expect(result.productionSecretWritten).toBe(true);
  });

  test("composes the production secret across both widgets as one JSON object", async () => {
    const p = fakeProvisioner();
    await provisionTurnstile(p, { modes: ["visible", "invisible"], productionDomain: "app.example.com" });
    expect(p.writeManagedSecret).toHaveBeenCalledWith(
      "prod",
      JSON.stringify({ visible: { key: "secret-visible" }, invisible: { key: "secret-invisible" } }),
    );
  });

  test("skips the production secret write when all widgets already exist (idempotent reuse)", async () => {
    const p = fakeProvisioner({ ensureProductionWidget: vi.fn(async () => ({ sitekey: "existing", secret: null })) });
    const result = await provisionTurnstile(p, { modes: ["visible"], productionDomain: "app.example.com" });

    // staging is still written (test value), but production secret is left as-is and flagged so the caller warns.
    expect(p.writeManagedSecret).toHaveBeenCalledWith("staging", expect.any(String));
    expect(p.writeManagedSecret).not.toHaveBeenCalledWith("prod", expect.any(String));
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
